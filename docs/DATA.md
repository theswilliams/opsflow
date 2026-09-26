# Data handling: what is stored, why, for how long, and how to remove it

This describes the engineering controls in the code. It is **not legal advice** and makes no compliance claim (for example under PIPEDA or any other regime). A real deployment that handles customer personal information needs its own privacy review, a lawful basis, a processing agreement with the AI provider, and a documented retention decision — the controls below exist so those decisions can be implemented, not so they can be skipped.

## What is stored

| Data | Table / column | Why | Default retention |
| --- | --- | --- | --- |
| Account: name, email, password hash (bcrypt), created time | `User` | Sign-in, ownership of data | Until the account is deleted (then anonymised) |
| Sessions (hash of token only) | `Session` | Stay signed in | 7 days / until logout or deletion |
| Submitted document text (pasted, `.txt`, or extracted from a PDF) | `WorkflowInput.content` | Shown to the reviewer, re-processing, audit of what the AI saw | `RETENTION_DAYS` (90) after the workflow finishes |
| Uploaded PDF bytes | `WorkflowInput.rawBytes` | Held only so a background job can parse them | Deleted as soon as parsed (or on failure) |
| Extracted fields (customer, address, dates, items, contact name/phone, instructions) and AI assessments | `ExtractedData` | The structured data under review | `RETENTION_DAYS` |
| Frozen approved snapshot, reviewer comment, list of edits | `Review` | Proves exactly what was approved | Snapshot: `RETENTION_DAYS`; decision/time: kept |
| Generated customer confirmation text | `WorkflowAction.output` | Record of the action | `RETENTION_DAYS` |
| Workflow shell (status, timestamps, confidence, version) | `Workflow` | Dashboard, history | Kept (identifying keys are cleared on purge/deletion) |
| Audit events (who/what/when; edit before/after values; **phone numbers masked**) | `AuditEvent` | Accountability | Kept; metadata redacted on account deletion |
| AI usage records (provider, model, tokens, estimated cost, workflow id) — no content | `AiUsage` | Spend control and visibility | Kept |
| Webhook credentials (key id, **encrypted** secret, label, last used) | `ApiCredential` | Authenticate n8n | Until revoked/account deleted |
| Webhook receipts (hash of the signature and of the content) | `WebhookReceipt` | Replay/duplicate protection | Kept (hashes only) |
| Simulated notifications | `Notification` | "A review is needed" | Deleted with the account |

Not stored: passwords in plain text, webhook secrets in plain text, session tokens, API keys, the raw HTTP bodies of webhook calls, the AI provider's raw responses.

## Where data goes

- **The AI provider** (when `AI_PROVIDER=claude`): the document text of each request is sent to Anthropic's API to be extracted. Nothing is sent in demo mode (the mock runs locally). Choosing to send customer documents to a third-party processor is the operator's decision; review the provider's data-retention terms.
- **Nowhere else.** The confirmation action is simulated; OpsFlow sends no email or SMS.

## Export

Signed-in users can download everything held about them as JSON: **Integrations → Your data → Download my data** (or `GET /api/account/export`). It includes profile, workflows (documents, extracted data, validation, reviews, actions), credentials (metadata only — never secrets), AI usage, notifications and audit events. Passwords hashes, webhook secrets and raw upload bytes are never included. Each export is itself recorded in the audit log.

## Deletion

**Delete my account** (Integrations → Your data; requires the password and typing `DELETE`) performs, in one transaction:

- destroys sign-in (the password hash is replaced by an unmatchable value), revokes all sessions and API credentials, cancels queued/running jobs and fails in-flight workflows;
- erases documents, extracted data, validation results, approved snapshots, reviewer comments, confirmation text and identifying workflow keys;
- anonymises the user row (`deleted-<id>@deleted.invalid`, name "Deleted user") — kept as a tombstone so foreign keys and the audit trail stay intact;
- **retains audit events** but replaces their metadata with `{"redacted": true}`, and appends an `ACCOUNT_DELETED` event.

Deletion is idempotent and cannot affect other accounts (tested).

## Retention purge

A background sweep (`purgeExpiredContent`, every 6 hours in the worker; `RETENTION_DAYS`, default 90, `0` disables) erases the document and extracted personal data of workflows that have been COMPLETED, REJECTED or FAILED for longer than the retention period, and records a `CONTENT_PURGED` audit event. The workflow page then says the content was purged. Status history and the audit trail remain.

## What the audit log retains, and why

Audit events are the accountability record (who approved what, when, and what they changed). They are append-only for the application (see [SECURITY.md](SECURITY.md#audit-log-what-is-and-is-not-promised)) and are retained indefinitely by design. They contain field names and before/after values of edits (phone numbers masked), never the raw document. If your retention policy requires erasing those values too, the account-deletion path already redacts them; a scheduled redaction of old events would be a small extension using the same `withAuditMaintenance` path.

## Not implemented (and why)

- **Password reset and email verification.** Both need a real, trustworthy email channel. A simulated one would be a backdoor (anyone could read the "sent" reset link), so these were left out and are listed as required work for real use.
- **Per-tenant encryption keys, field-level encryption of documents at rest** (the database should use disk/volume encryption), **data-residency controls**, **consent records**.
