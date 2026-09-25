# Engineering decisions

Short records of the choices that shape the project, with the trade-off accepted. Decisions 15–24 come from the audit remediation.

### 1. Nothing executes without a person — even "clean" requests
**Decision.** Every workflow passes through `REVIEW_REQUIRED`. Business rules decide *how much attention* it needs (`needsAttention`, reasons), not *whether* a human is involved.
**Why.** The brief's core constraint. An auto-approve threshold on model confidence would be the first thing to fail in production, and its right value is a business decision.
**Cost.** More clicks for routine requests. A policy hook (auto-approve for verified customers + validation pass + verified evidence) is a natural extension.

### 2. Approval is enforced twice — and bound to a version
The executor requires a persisted `Review(decision = APPROVED)` *with a frozen snapshot* in addition to a legal status, so a forged status column cannot trigger the action. Approval commits only if `Workflow.version` still equals the version the reviewer loaded (see decision 16).

### 3. Validation is a separate, pure layer, re-run at approval
The model's opinion is an input, never a verdict. Approval recomputes validation from the current fields rather than trusting the last stored result, and the review page shows validation computed at load so Approve never looks enabled when the server would refuse.

### 4. Qualitative confidence
The UI shows High/Medium/Low/Unknown. LLM self-reported numbers are not calibrated; percentages would imply precision that does not exist.

### 5. Strict schema; reject rather than repair
Unknown fields fail the whole reply. The only "repairs" are downgrades, never silent acceptance of new data.

### 6. Provider abstraction with a real mock
`AIProvider`/`ActionProvider` interfaces, a deterministic rule-based `MockAIProvider`, and a UI banner. No silent fallback from `claude` to `mock`; the provider is a factory so misconfiguration is an explicit, typed error at the point of use.

### 7. PostgreSQL constraints for invariants — declared in the schema where possible
Tenant consistency (composite FKs), single review, single action per workflow, one job per (workflow, type), replay ledger — all in `schema.prisma`. What Prisma cannot express (audit triggers, CHECKs) is hand-written *and guarded* by an integrity test, a migration guard script and a CI drift check. (An earlier design kept two constraints as unguarded hand-written SQL; the audit rightly flagged that a future `migrate dev` could drop them.)

### 8. Custom session auth instead of a library
Requirements were small and the security properties are easy to state and test. A hosted identity provider would be preferable for production (MFA, reset, SSO).

### 9. Server Actions for the UI, Route Handlers for machines
Actions get built-in origin checks and colocate with forms; the webhook needs raw-body access, custom status codes and signatures, so it is a plain `Request → Response` function tests call directly.

### 10. Webhook: everything a client controls is signed; the database decides duplicates
The signature covers the idempotency key. Replay and duplicate detection are decided by a durable `WebhookReceipt` ledger with DB uniqueness and an advisory lock — not by memory, and not by a client-controlled header. Polling instead of callbacks avoids accepting caller-supplied URLs (SSRF).

### 11. Real PostgreSQL in tests (no mocks for the data layer)
Global setup starts a throw-away Postgres and runs the real migrations, so the constraints, triggers, locks and transactions above are actually exercised — including concurrency tests that would be meaningless against a mock.

### 12. Time is a dependency
"This Friday" needs a reference date and a timezone. The clock and `BUSINESS_TIMEZONE` are injected and validated at startup.

### 13. What was deliberately left out
OCR (extension point exists), real notifications (simulated), multi-user tenancy/roles, password reset/email verification/MFA (need a trustworthy email channel; a simulated one would be a backdoor), distributed rate limiting, additional workflow types. Each is listed in the README's limitations rather than half-built.

### 14. (Superseded) Synchronous processing
The first version ran extraction inside the request. The audit showed this could strand workflows; see decision 15.

### 15. Slow work is a durable job, with leases, fencing and a sweeper
**Decision.** Creating a workflow enqueues a job in the same transaction. Workers claim with `FOR UPDATE SKIP LOCKED` and a lease; `attempts` is a fencing token checked in every write; the slow AI/PDF call is followed by *one* atomic commit; a sweeper re-queues expired leases and repairs orphans; retries are bounded and end in an explicit `FAILED`.
**Why.** "Increase the timeout" is not a fix: any process can die between two commits. The invariant "a workflow in a working state always has a live job or an explicit failure" is enforceable; "the request will finish" is not.
**Cost.** More moving parts (queue table, worker loop). It stays on PostgreSQL — no new infrastructure — and requests still give their own job a head start, so the demo feels synchronous.

### 16. Optimistic versioning for human review
`Workflow.version` increments on every material change. Approval is `UPDATE … WHERE version = :seen`, and the approved fields are snapshotted. A hash or `updatedAt` would also work; an integer is simplest to reason about, cannot collide, and is visible in the audit trail. Metadata-only actions (a comment, a no-op edit, a failed edit) intentionally do not bump it.

### 17. Outbox + idempotency key for side effects
The action row is created with the approval and carries a deterministic key; the executor marks it `EXECUTING` durably before calling the provider *with the key*. A unique index cannot prevent an already-sent email; only an idempotent provider contract can, and a real provider must honour it (documented on the interface, enforced by a test double that behaves like Stripe/SES).

### 18. Evidence is verified by code, per field
Evidence used to be "the quote appears somewhere". It is now: meaningful, locatable (with an OpsFlow-computed span), and demonstrably supporting *that field's* value; and the pipeline — not the model — decides `requires_human_review` and `recommended_action`. Strictness is a deliberate trade: false rejections downgrade a field to "needs a look", which is the safe direction.

### 19. Rate limiting: identify the client honestly, or don't limit by client
A shared "direct" bucket let one outsider lock everyone out. Now the client address comes from the real socket (MAC-protected header from `server.mjs`) and rightmost-untrusted-hop forwarding, failure limits only block the failing address, authenticated limits are per tenant *and* per credential, and an unknown address disables address-keyed limits rather than pooling everyone. There is no per-email login lockout (it is a denial-of-service lever). The cost — distributed credential guessing is throttled only by bcrypt — is documented.

### 20. Cost ceilings live in the database and reserve before they spend
AI budgets and credential caps are exact across instances because they are rows, not memory. The AI budget uses *reserve-then-call* under an advisory lock so concurrency cannot overshoot the request count.

### 21. Audit log: promise only what is enforced
UPDATE/DELETE/TRUNCATE are refused by triggers; FKs are `RESTRICT` so nothing cascades into the log; the only exceptions (account erasure redaction, demo reset) are explicit and tested. It is **not** owner-proof or tamper-evident, and the documentation says so.

### 22. Duplicate detection is exact-on-normalised-keys, not fuzzy
Deterministic normalisation (Unicode folding, punctuation, legal suffixes, street types) and an indexed equality lookup. Fuzzy matching would be unbounded, non-reproducible and prone to false positives on a step that merely warns.

### 23. Nonce-based CSP via the Next.js proxy
`script-src 'self' 'nonce-…' 'strict-dynamic'` with no `'unsafe-inline'`. It forces dynamic rendering of every page (acceptable: everything is authenticated and per-user). `CSP_MODE=report-only` supports staged rollout. Verified in a real browser, because CSP regressions show up as silent hydration failures that unit tests cannot see.

### 24. Data protection as engineering controls, not claims
Export, anonymising deletion, retention purge and a data inventory are implemented; no compliance is claimed. Password reset / email verification are left out on purpose (decision 13).
