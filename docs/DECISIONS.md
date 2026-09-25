# Engineering decisions

Short records of the choices that shape the project, with the trade-off accepted.

### 1. Nothing executes without a person — even "clean" requests
**Decision.** Every workflow passes through `REVIEW_REQUIRED`. Business rules decide *how much attention* it needs (`needsAttention`, reasons), not *whether* a human is involved.
**Why.** The brief's core constraint. An auto-approve threshold on model confidence would be the first thing to fail in production, and its right value is a business decision.
**Cost.** More clicks for routine requests. Mitigation: routine items are one click; a policy hook (auto-approve for verified customers + validation pass + high confidence) is a natural extension.

### 2. Approval is enforced twice
`executeApprovedWorkflow` requires both a legal status *and* a persisted `Review(decision = APPROVED)`. A forged or corrupted status column cannot trigger the action (tested). Double execution is prevented by compare-and-set transitions and a partial unique index (`status = 'SUCCEEDED'`).

### 3. Validation is a separate, pure layer, re-run at approval
The model's opinion is an input, never a verdict. Approval recomputes validation from the current fields rather than trusting the last stored `ValidationResult`, so a stale result cannot be approved after an edit or a date rollover.

### 4. Qualitative confidence
The UI shows High/Medium/Low/Unknown. LLM self-reported numbers are not calibrated; percentages would imply precision that does not exist. Documented in the UI and in `AI_PIPELINE.md`.

### 5. Strict schema; reject rather than repair
Unknown fields fail the whole reply. The only "repairs" are downgrades (evidence not in source → lower confidence; status/value contradictions), never silent acceptance of new data. The alternative — lenient parsing — is precisely how prompt-injected fields sneak in.

### 6. Provider abstraction with a real mock
`AIProvider`/`ActionProvider` interfaces, a deterministic rule-based `MockAIProvider`, and a UI banner. The mock exists so the product is evaluable with no key; it is labelled as a mock everywhere and there is no silent fallback from `claude` to `mock`.

### 7. PostgreSQL constraints for invariants
Tenant consistency (composite FKs), single success per workflow, single review, append-only audit, idempotency uniqueness. Application code is still careful, but the invariants that matter most cannot be violated by a future bug. Cost: a few hand-written SQL statements Prisma cannot model (documented; `migrate diff` flags one index as extra).

### 8. Custom session auth instead of a library
Requirements were small (email+password, sessions, logout, ownership) and the security properties (hashed tokens, uniform-time login, revocation) are easy to state and test. A hosted identity provider would be preferable for production (MFA, reset, SSO) — see Limitations.

### 9. Server Actions for the UI, Route Handlers for machines
Actions get built-in CSRF-style origin checks and colocate with forms; the webhook needs raw-body access, custom status codes and signatures, so it is a plain `Request → Response` function (`handleWorkflowPost`) that tests call directly with no HTTP server.

### 10. Webhook: signature-as-idempotency-key, polling instead of callbacks
Replay protection without a nonce table: the signature uniquely identifies a request, and the existing per-user unique key does the rest. Polling avoids accepting caller-supplied URLs (SSRF).

### 11. Real PostgreSQL in tests (no mocks for the data layer)
Global setup starts a throw-away Postgres (`embedded-postgres`) and runs the real migrations, so the constraints, triggers and transactions above are actually exercised. CI uses a service container via `TEST_DATABASE_URL`.

### 12. Time is a dependency
"This Friday" needs a reference date and a timezone. The clock and `BUSINESS_TIMEZONE` are injected (`WorkflowDeps.now/timezone`), which makes tests deterministic and avoids server-timezone bugs.

### 13. Synchronous processing
Extraction runs inside the request (seconds with a real model). A job queue is the right answer at volume; here it would add infrastructure without demonstrating anything the state machine doesn't already show. The state machine is written so processing could move to a worker unchanged.

### 14. What was deliberately left out
OCR (extension point exists), real notifications (simulated provider), multi-user tenancy/roles, password reset/MFA, distributed rate limiting, a job queue, and additional workflow types. Each is listed in the README's limitations rather than half-built.
