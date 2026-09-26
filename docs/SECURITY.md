# Security model

Assumption used throughout: **an attacker controls every document, webhook body, URL parameter and browser request.**

This document describes what the code does **today**. Where a guarantee has limits, the limit is stated next to it. The remediation history for the independent audit of commit `b16395f` is in [Audit remediation](#audit-remediation-f1f11) below.

## Assets and trust boundaries

| Asset | Where | Protected by |
| --- | --- | --- |
| Tenant data (workflows, extracted PII) | PostgreSQL | user-scoped queries + composite foreign keys |
| Credentials (passwords, sessions, webhook secrets) | PostgreSQL | bcrypt, token hashing, AES-256-GCM |
| Approval integrity | app + DB | human-only approval bound to a version, persisted `Review` snapshot, unique constraints |
| External side effects | app + provider | outbox row + deterministic idempotency key |
| Audit trail | PostgreSQL | append-only guard (see [what is promised](#audit-log-what-is-and-is-not-promised)) |
| Model API key | environment | never logged, never sent to the client |

Untrusted inputs: document text, uploaded files, webhook payloads/headers, form data, URL params, **and model output**.

## Client address trust model

Rate limiting needs to know who a client is. Route handlers cannot see the TCP socket, so:

1. **`server.mjs` (used by `npm start` / `npm run dev`)** stamps each request with the real peer address in `x-opsflow-peer` plus `x-opsflow-peer-mac = HMAC(per-process secret, peer)`, after deleting any client-supplied copies. The MAC is essential: if the app is ever run *without* the custom server (plain `next start`, a platform runtime), a client could send `x-opsflow-peer` itself — but it cannot produce a valid MAC, so the header is ignored. (Found in the second audit; regression-tested.)
2. If the verified peer is **not** in `TRUSTED_PROXIES`, forwarding headers are ignored completely and the peer *is* the client.
3. If the peer **is** a trusted proxy, `X-Forwarded-For` is walked **from the right**; the first address that is not itself a trusted proxy is the client. The leftmost entry is client-controlled and never used on its own. Malformed CIDR entries are skipped, never widened.
4. **Platform mode** (no socket info): with `TRUST_PROXY_HOPS=n` the client is the *n*-th entry from the right.
5. Otherwise the address is **unknown**. Unknown never means "everybody": address-keyed limits are skipped, not collapsed into one shared bucket.

Operator responsibility: `TRUSTED_PROXIES` must list only infrastructure you control. Setting it to `0.0.0.0/0` disables the protection.

## Rate limiting and abuse controls

All in-memory limiters are **per process**; with N instances each limit can be used N times over. Cost-critical ceilings (AI budgets, credential counts, idempotency) live in the **database** and are exact across instances.

| Control | Keyed by | Behaviour |
| --- | --- | --- |
| Webhook failed authentication | client address | Only clients that fail are ever blocked (20 failures/min → 429 for that address). A valid signature is **never** rejected because of anyone else's traffic. Skipped when the address is unknown. |
| Webhook authenticated capacity | credential **and** tenant | 60/min per credential and 120/min per tenant (configurable) — minting more credentials cannot multiply a tenant's allowance, and one tenant cannot use another's capacity. |
| Login failures | (email, address) and address | 8 per 15 min per (email, address); 40 per 15 min per address. There is deliberately **no** per-email global lockout, which would let anyone lock out a chosen user. |
| Registration | address | 10/hour per address; skipped when unknown. |
| Workflow creation from the UI | user | 20/min. |
| Credential creation | user (DB cap + limiter) | Max 5 active per user (DB, race-safe via advisory lock), 5/hour. |
| AI usage | user (DB) | Daily request/token budgets and an optional monthly cost budget, enforced by *reserve-then-call* under a per-user advisory lock. |

Residual: distributed guessing against a single account is throttled only by bcrypt cost (there is no account lockout, by design) — front the app with a WAF/CAPTCHA for public deployments.

## Authentication

- Passwords: bcrypt cost 12; 10–72 byte policy (longer is rejected rather than silently truncated).
- Login is uniform-time (a dummy hash is verified for unknown emails) and returns one generic message.
- Sessions: 32 random bytes, delivered as an `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie. Only the SHA-256 of the token is stored. Logout deletes the row; expiry is enforced on read.
- Known gaps: **no password reset, no email verification, no MFA** (see [DATA.md](DATA.md) and the README for why they were not faked); registration reveals whether an email exists.

## Authorization (IDOR / BOLA)

- Every read and write includes `userId` in the `WHERE` clause. Someone else's workflow is a 404, indistinguishable from a missing one.
- The database backs this up: children reference `(workflowId, userId)`, so a row with a mismatched owner cannot be inserted (jobs, receipts, AI usage, actions, reviews… — tested).
- Tests cover read, list, search-by-id-fragment, stats, activity, notifications, AI usage, export and every mutation across two tenants.

## Human approval is bound to what the reviewer saw

- Every extraction/edit carries an optimistic **version** (`Workflow.version`). Approval requires `expectedVersion` and commits only in the same `UPDATE … WHERE version = ?` that flips the status, so a concurrent edit cannot slip in between check and approval.
- A frozen snapshot of the approved fields (`Review.approvedFields`) is what the action executes — later changes to the live row cannot alter it.
- The UI displays validation computed *at page load*, so Approve never looks enabled when the server would refuse.
- Verified through the real UI with headless Chrome (`scripts/e2e-smoke.mjs`): tab B edits the address, tab A's approval is refused with a "request changed" notice, nothing is sent, and approving the reloaded version executes exactly what was reviewed.

## Webhook

`POST /api/webhooks/workflow`, `GET /api/webhooks/workflow/:id`.

Order of checks: failing-client throttle → content type → body size (streamed, aborts at 64 KiB) → credential lookup + signature (constant work for known and unknown key ids) → tenant/credential limits → JSON → strict schema → durable ledger → idempotency.

- **Signature v1**: `sha256=HMAC(secret, "v1" LF timestamp LF idempotency-key LF raw-body)`. The idempotency key is *inside* the signed message. Constant-time compare; timestamp must be within 5 minutes in the past and 60 seconds in the future.
- **Replay and duplicates** are decided by the database, not memory. Each authenticated request is recorded in `WebhookReceipt` with unique `(userId, signatureHash)`; creation runs under a per-(tenant, content) advisory lock:
  - exact replay → the original workflow (`200`, `duplicate: true`);
  - explicit idempotency key seen before → the original workflow (`409` if the content differs);
  - the same *content* re-signed under another key/timestamp inside a 5-minute window → the original workflow;
  - so a captured request cannot be turned into new workflows by changing anything the client controls.
- **Uniform failures and timing**: unknown key, wrong signature, stale/future timestamp and missing headers return the identical `401`; known and unknown key ids do the same work (one decrypt, one HMAC), and the audit write for a known key happens off the response path.
- **Secrets**: per-user credentials; the secret is shown once, stored AES-256-GCM encrypted, revocable.
- **No SSRF surface**: the webhook makes no outbound requests. There is deliberately **no callback URL** — n8n polls the signed `GET`.
- Responses: `Cache-Control: no-store`, `x-request-id` for correlation, no internals in error bodies.

## Background jobs and recovery

All slow work (PDF parsing, AI extraction, the customer action) runs as a durable job (`Job` table), never as an HTTP request that must survive.

- One job row per `(workflow, type)`; `INSERT … ON CONFLICT` makes enqueue race-free.
- Workers claim with `FOR UPDATE SKIP LOCKED` and a lease; `attempts` is a **fencing token** — a worker that lost its lease cannot write (`assertLease` on every state change).
- After the slow call everything is committed in **one transaction**, so there is no window that strands `EXTRACTED`/`VALIDATING`.
- A sweeper re-queues expired leases (or fails them explicitly after `JOB_MAX_ATTEMPTS`) and re-enqueues workflows that are in a working state with no live job. **No state is left in limbo**: it is either being worked on, waiting for a person (`REVIEW_REQUIRED`), or explicitly `FAILED` with a Retry.

## External actions: at-most-once side effects

The action is an **outbox** row created in the approval transaction with a deterministic idempotency key `wf:<id>:customer_confirmation:v<approved version>`. The executor: (1) marks it `EXECUTING` durably, (2) calls the provider *with the key*, (3) commits `SUCCEEDED`. If step 3 fails, the retry re-calls the provider with the **same key**; a provider that honours idempotency (as real email/SMS APIs do) performs the effect once. The provider interface documents this requirement. A unique index alone could not do this — it fires only after the email has been sent.

## AI-specific

See [AI_PIPELINE.md](AI_PIPELINE.md). Summary: instructions/data separation, strict output schema, **deterministic field-scoped evidence verification** (the model can no longer certify itself), pipeline-owned review decision, single data-returning tool, per-user spend ceilings, and a hard human-approval boundary.

## Injection, XSS, CSRF

- **SQL**: Prisma parameterises everything; raw SQL is limited to the queue, advisory locks and health check, all bound parameters.
- **XSS / CSP**: React escapes all output; the original document is shown in a `<pre>`; a test fails the build if `dangerouslySetInnerHTML`/`eval` appears in `src`. The **CSP is nonce-based** (`src/proxy.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'` with **no `'unsafe-inline'`**, plus `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`. Styles keep `'unsafe-inline'` (style injection cannot execute script). `CSP_MODE=report-only` supports staged rollout. Verified in a real browser (no violations, pages hydrate).
- **CSRF**: mutations are Server Actions (POST; Next.js rejects cross-origin `Origin`/`Host` mismatches — framework behaviour, not separately tested here) and cookies are `SameSite=Lax`. There are no state-changing GET routes; the data-export GET additionally refuses cross-site `Sec-Fetch-Site`.
- **Headers**: `X-Frame-Options: DENY`, `nosniff`, strict `Referrer-Policy`, HSTS in production.
- **Open redirects**: `redirect()` is only called with constants or database ids.

## Uploads

Format is decided from **magic bytes**, not the name or MIME type. `.txt` must be valid UTF-8 with no NUL bytes. PDFs are parsed **in a worker thread** (`unpdf`) with a wall-clock timeout (`PDF_TIMEOUT_MS`), a 256 MB heap cap, a 25-page cap, and at most two parses at once; on timeout the worker is terminated. The request path only does cheap checks. Images are recognised and refused (no OCR). 2 MB limit; file names are stripped of paths/control characters. Raw bytes are held only until parsed. Extracted text over 20,000 characters is rejected, not truncated.

## Audit log: what is and is not promised

**Promised:** the *application and its database role* cannot alter or delete audit events by any normal code path — `UPDATE`, `DELETE` and `TRUNCATE` on `AuditEvent` are refused by database triggers; the foreign keys are `RESTRICT`, so deleting a user or workflow can never cascade into the audit trail; and the only sanctioned exceptions (`withAuditMaintenance`: account erasure redaction and the demo reset) are explicit, transaction-scoped and tested. Audit metadata never contains raw document text.

**Not promised:** immunity from the database **owner/superuser**. Whoever owns the schema can drop the triggers or set the maintenance flag. The log is not hash-chained or externally anchored, so it is *not* cryptographically tamper-evident. Stronger guarantees would need a separate non-owner application role and/or shipping events to write-once storage — both out of scope here.

Retention policy: audit events are kept indefinitely; on account deletion their metadata is redacted and they remain attributable to an anonymised tombstone. Details in [DATA.md](DATA.md).

## Migrations and database safeguards

Everything Prisma can express is declared in `schema.prisma` (including the single-review, single-action and job/receipt uniqueness — the old hand-written partial index is gone). What Prisma cannot express — the audit triggers and CHECK constraints — is hand-written **and guarded three ways**: `tests/db-integrity.test.ts` asserts every safeguard exists in a database built purely from the migrations; `scripts/check-migrations.mjs` (CI) fails if a migration drops one; and CI replays all migrations into a scratch database and runs `prisma migrate diff` against `schema.prisma`. The guard itself is tested (it was caught being vacuous once).

## Sensitive data and logging

- The logger redacts keys matching password/secret/token/authorization/api-key/signature/cookie/text/content/body/email/phone/address and truncates long strings; errors are logged as name + message, never stacks. Job `lastError` (operator-only) is never rendered to users.
- Audit metadata never contains raw document text; phone numbers are masked in edit records.
- Users see generic messages with a request/digest reference; provider and database errors stay in logs.
- Secrets are only read from the environment; `.env` is git-ignored; the setup script generates random ones.

## Dependency and supply chain

`npm audit`: 0 vulnerabilities (two advisories in the Prisma CLI's transitive dev dependencies are fixed with `overrides`). CI runs `npm audit --audit-level=high`, has `permissions: contents: read`, and pins third-party actions to full commit SHAs.

## Audit remediation (F1–F11)

Independent audit of commit `b16395f`; each finding was reproduced first, fixed, and covered by regression tests.

| # | Finding | Fix | Tests |
| --- | --- | --- | --- |
| F1 | Replay bypass: unsigned `Idempotency-Key` outranked the signature-derived key (5 replays → 5 workflows) | Key inside the signature; durable receipt ledger with DB uniqueness; content-window dedupe; advisory-locked creation | `webhook › F1` (10 cases) |
| F2 | "direct" shared bucket → one outsider could lock out everyone | Peer address from the socket (MAC-protected), rightmost-trusted-hop XFF, failure-only per-address throttle, per-tenant limits, no per-email lockout | `webhook › F2`, `network-and-config` |
| F3 | Workflows stuck forever (RECEIVED, PROCESSING, VALIDATING, EXECUTING) | Durable job queue, leases + fencing, atomic finalisation, sweeper, bounded retries, explicit FAILED | `jobs-recovery` (19) |
| F4 | Approval not tied to the version seen | Mandatory `expectedVersion`, atomic predicate, frozen approved snapshot, live validation on the page | `approval-version`, `e2e-smoke` |
| F5 | Action could run twice after a failed commit | Outbox row + deterministic idempotency key passed to the provider | `action-outbox` |
| F6 | Credential multiplication; unbounded AI spend | Credential cap, tenant limiter, per-user AI budgets with atomic reservation, usage records | `budget-limits`, `webhook › tenant capacity` |
| F7 | Audit log weaker than documented | UPDATE/DELETE/TRUNCATE guards, RESTRICT FKs, explicit maintenance path, honest documentation | `db-integrity › F7` |
| F8 | Hand-written constraints could be dropped by a future migration | Moved into `schema.prisma` where expressible; guard script; drift check in CI; integrity test | `db-integrity › F8` |
| F9 | Evidence check satisfiable by "the" | Field-scoped deterministic verification with real source spans; pipeline owns the review decision | `evidence` (21) |
| F10 | Duplicate check: 25 arbitrary rows, exact name | Normalised customer/address keys, indexed exact lookup, no cap | `duplicates` (35) |
| F11 | Crafted PDF could freeze the server | Worker thread, timeout, memory cap, page cap, pool of 2, durable job | `pdf` (12) |

Additional findings from the **second (post-fix) audit**, all fixed with tests:

| Finding | Fix |
| --- | --- |
| The new `x-opsflow-peer` header would have been attacker-controlled if the app ran without `server.mjs` | Header must carry a per-process HMAC; otherwise ignored |
| Malformed CIDR (`10.0.0.1/33x`) in `TRUSTED_PROXIES` silently *trusted the address* | Malformed entries are skipped |
| AI budget check and record were not atomic (concurrent jobs could overshoot) | Reserve-then-call under a per-user advisory lock |
| Concurrent enqueue (user retry + sweeper) could raise a unique-violation | Single-statement `INSERT … ON CONFLICT … WHERE` |
| The migration guard regex was silently vacuous (escapes lost) | Rewritten with `String.raw`, and the guard is now tested |
| Cross-site GET could trigger a data export | `Sec-Fetch-Site` check |
| Webhook JSON with `__proto__` / deep nesting | Verified rejected (400), no pollution |

## Residual risk

No MFA, password reset or email verification; open registration; in-memory rate limits (single instance); the audit log is not owner-proof or tamper-evident; style CSP allows inline styles; token/cost budgets can overshoot by the in-flight requests; the live Claude provider and the n8n workflow import have not been exercised against the real services; no malware scanning of uploads (text is extracted, files are not stored); PDF parsing is bounded but pdf.js remains a large attack surface (mitigated by isolation, not eliminated); single `APP_ENCRYPTION_KEY` without rotation tooling; free-form document text can still contain personal data that ends up in the model provider's logs (a data-processing decision for the operator).
