# Security model

Assumption used throughout: **an attacker controls every document, webhook body, URL parameter and browser request.**

## Assets and trust boundaries

| Asset | Where | Protected by |
| --- | --- | --- |
| Tenant data (workflows, extracted PII) | PostgreSQL | user-scoped queries + composite FKs |
| Credentials (passwords, sessions, webhook secrets) | PostgreSQL | bcrypt, token hashing, AES-256-GCM |
| Approval integrity | app + DB | human-only approval, persisted `Review`, unique indexes |
| Audit trail | PostgreSQL | append-only trigger, throttled rejected-call events |
| Model API key | environment | never logged, never sent to the client |

Untrusted inputs: document text, uploaded files, webhook payloads/headers, form data, URL params, **and model output**.

## Authentication

- Passwords: bcrypt cost 12; 10–72 byte policy (longer is rejected rather than silently truncated).
- Login is uniform-time (a dummy hash is verified for unknown emails) and returns one generic message.
- Sessions: 32 random bytes, delivered as an `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie. The database stores only the SHA-256 of the token, so a database read does not yield usable sessions. Logout deletes the row; expiry is enforced on read.
- Rate limits: login 8/15 min per email and 40/15 min per IP; registration 10/hour per IP.
- Known gap: registration reveals whether an email exists (acceptable for a self-serve demo, rate-limited). No MFA, reset or verification.

## Authorization (IDOR / BOLA)

- Every read and write includes `userId` in the `WHERE` clause — see `workflow/queries.ts` and `service.ts` (`loadOwned`). Someone else's workflow is a 404, indistinguishable from a missing one.
- IDs are random cuids and are never trusted: server actions receive the workflow id from the client but re-scope by the session user.
- Defence in depth in the database: children reference `(workflowId, userId)`, so a row with a mismatched owner cannot be inserted even by a buggy code path (`tests/workflow-service.test.ts`).
- Tests (`tests/authorization.test.ts`) exercise read, list, search-by-id-fragment, stats, activity feed and every mutation across two tenants, and assert nothing changed.

## Webhook

`POST /api/webhooks/workflow`, `GET /api/webhooks/workflow/:id`.

Order of checks: per-IP rate limit → content type → body size (streamed, aborts at 64 KiB) → credential lookup → signature → per-key rate limit → JSON → strict schema → idempotency.

- **Signature**: `sha256=HMAC(secret, "<unix-ts>.<raw body>")`, constant-time compare, ±300 s tolerance. Binding the timestamp to the body prevents body tampering and stale replays.
- **Uniform failures**: unknown key, wrong signature, stale timestamp and missing headers return the identical `401`.
- **Replay**: within the tolerance window a captured request could otherwise be re-sent. Without an explicit idempotency key the *signature* becomes the key, so a replay returns the original workflow (`200`, `duplicate: true`). Regression-tested.
- **Idempotency**: `Idempotency-Key` header or `external_id`, unique per user; reuse with different content → `409`.
- **Brute-force / abuse**: failed attempts are limited per (key, IP); rejected calls are audited but throttled to 3/hour/key so the audit log cannot be flooded.
- **Secrets**: per-user credentials; the secret is shown once, stored AES-256-GCM encrypted (`APP_ENCRYPTION_KEY`), revocable.
- **No SSRF surface**: the webhook never makes outbound requests. There is deliberately **no callback URL** parameter — n8n polls the signed `GET` instead. Adding callbacks would require an allow-list and DNS-rebinding-safe fetching.
- Responses: `Cache-Control: no-store`, `x-request-id` for correlation, no internals in error bodies (tested with hostile provider errors).

## AI-specific

See [AI_PIPELINE.md](AI_PIPELINE.md#prompt-injection-model). Summary: instructions/data separation, strict output schema, evidence verification, single data-returning tool, and a hard human-approval boundary. The action executed after approval is *rendered from validated, human-approved fields*, not from model text.

## Injection, XSS, CSRF

- **SQL**: Prisma parameterises everything; the only raw query is a static `SELECT 1`.
- **XSS**: React escapes all output; the original document is shown in a `<pre>`; a test fails the build if `dangerouslySetInnerHTML` appears in `src`. CSP: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'` (plus `'unsafe-inline'` scripts because Next.js hydration requires it without nonces — a documented compromise).
- **CSRF**: all mutations are Server Actions (POST; Next.js rejects cross-origin `Origin`/`Host` mismatches) and cookies are `SameSite=Lax`. There are no state-changing GET routes. The webhook uses signatures, not cookies.
- **Clickjacking / sniffing**: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, strict `Referrer-Policy`, HSTS in production.
- **Open redirects**: `redirect()` is only ever called with constants or database ids.

## Uploads

Format is decided from **magic bytes**, not the name or MIME type. `.txt` must be valid UTF-8 with no NUL bytes; PDFs are parsed with pdf.js (`unpdf`) with a 25-page cap; images are recognised and refused (no OCR). 2 MB limit; file names are stripped of paths and control characters and used only as display text. Extracted text is capped at 20,000 characters (rejected, not truncated, to avoid silently dropping content).

## Rate limiting and proxies

Limiters are in-memory and per process. Client IP comes from `X-Forwarded-For` **only when `TRUST_PROXY=true`**; otherwise all callers share one bucket, so a spoofed header cannot dodge limits (regression-tested). For multi-instance deployments replace `RateLimiter` with a shared store (Redis/Postgres) — the class is deliberately small so this is a drop-in.

## Sensitive data and logging

- The logger redacts keys matching password/secret/token/authorization/api-key/signature/cookie/text/content/body/email/phone/address and truncates long strings; errors are logged as name + message, never stacks.
- Audit metadata never contains raw document text; phone numbers are masked in edit records.
- Users see generic messages with a request/digest reference; provider and database errors stay in logs.
- Secrets are only read from the environment; `.env` is git-ignored; `.env.example` contains no values; the setup script generates random ones. The seed refuses to run without `DEMO_USER_PASSWORD`.

## Dependency review

`npm audit` reports 0 vulnerabilities. Two advisories affected the Prisma CLI's transitive dependencies (`mysql2`, `deepmerge-ts`, dev-time only, not used at runtime); they are resolved with `overrides` in `package.json`, and Prisma generate/migrate were re-verified. CI runs `npm audit --audit-level=high`.

## Findings from the security review

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | Captured signed webhook request could be replayed inside the 5-minute window to create duplicate workflows | Signature-derived implicit idempotency key | `security-regressions › replay` |
| 2 | `X-Forwarded-For` trusted unconditionally, letting a client rotate its "IP" to bypass rate limits | Honoured only with `TRUST_PROXY=true` | `security-regressions › spoofed client-IP headers` |
| 3 | Audit events were mutable by anyone with DB write access | `BEFORE UPDATE` trigger | `security-regressions › audit trail tampering` |
| 4 | Bad-signature throttling keyed by key id alone would let a stranger lock out a legitimate client | Keyed by (key id, IP) | `webhook › throttles repeated bad signatures` |
| 5 | Hostile provider/DB/action errors could reach users or audit rows | Generic user messages, cause kept for logs | `webhook`, `workflow-service › does not leak internal error details` |
| 6 | Status column alone could authorise execution if forged | Execution also requires a persisted approval | `workflow-service › cannot execute even if status is forged` |

## Not covered / residual risk

No MFA or password reset; open registration; in-memory rate limits; `unsafe-inline` script CSP; no malware scanning of uploads (text is extracted, files are not stored); PDF parsing is bounded by size/pages but not by wall-clock; no per-tenant encryption keys; single `APP_ENCRYPTION_KEY` without rotation tooling; the live Claude path is unverified against the real API.
