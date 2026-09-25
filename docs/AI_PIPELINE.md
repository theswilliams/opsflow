# AI pipeline

## Goals

1. Get useful structure out of messy text.
2. Never let the model *decide* anything consequential.
3. Make uncertainty first-class (known / inferred / ambiguous / missing).
4. Treat the document — and the model's reply — as untrusted input.

## Stages

```text
text ─► clean & limit ─► provider.extract() ─► strict schema ─► reconcile ─► store
            │                    │                  │              │
       control chars        timeout, retry     unknown fields   evidence must
       length ≤ 20k         classify errors    are rejected     exist in source
```

### 1. Input handling (`ai/extract.ts`)

`cleanText` normalises newlines and removes control, zero-width and bidirectional-override characters. Empty input and input over 20,000 characters are rejected before any model call (cost and abuse control). Uploads are limited to 2 MB / 25 PDF pages and converted to text first (`documents/extract.ts`).

### 2. Prompt (`ai/prompt.ts`)

- **All instructions are in the system prompt**, including an explicit statement that the document is untrusted data and that instruction-like text inside it must be ignored and reported as an ambiguity.
- The document goes in the user turn inside `<document>…</document>`, with the reference date in `<reference_date>`. `escapeDocument` breaks any `<document>`, `<system>` or similar tag in the text so it cannot close or spoof the delimiters.
- The model must respond **only** by calling `record_extraction`; `tool_choice` forces it. The tool's JSON Schema is generated from the Zod schema (`z.toJSONSchema`), so the contract exists in exactly one place.
- `temperature: 0`, `max_tokens: 2048`, SDK retries disabled (the pipeline owns retry policy).

### 3. Schema (`ai/schema.ts`)

Every object is `.strict()`. The reply contains:

- `fields` — customer, address, `requested_date` (`YYYY-MM-DD`), time window / start / end, `items[]`, contact name/phone, special instructions.
- `field_assessments` — for **each** field: `status` (`known | inferred | missing | ambiguous`), `confidence` (`high | medium | low | unknown`), a short verbatim `evidence` quote, and a `note`.
- `missing_information[]`, `ambiguities[]` (field + note), `requires_human_review`, `reason`, `recommended_action`.

Any extra key anywhere, a bad date format, an over-long string, or a missing assessment fails validation. There is no "best effort" acceptance of a malformed reply.

### 4. Retry policy

- Up to 2 attempts, 30 s timeout each (`AbortSignal.timeout`).
- Schema failure → retry once with **structural feedback only** (`fields.items.0.quantity (invalid_type)`), never echoing model-produced values back into a prompt.
- Provider errors are classified (`timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`); `auth` and `bad_request` are not retried.
- Exhausted retries raise `ExtractionError` with a **user-safe** message. The provider's own message (which may contain keys or internals) is kept only as `cause` for logs.

### 5. Reconciliation (`reconcileExtraction`)

Even a schema-valid reply can be wrong or adversarial:

- **Evidence must exist in the source.** If the quoted `evidence` is not a substring of the normalised source text, it is dropped, `known` becomes `inferred`, confidence is capped at `medium`, and a note is added.
- **Status and value must agree.** A value marked `missing` becomes `inferred/low`; `known`/`inferred` with no value becomes `missing`.
- Corrections are recorded in the audit event metadata.

### 6. Storage

`ExtractedData.aiOutput` holds the validated reply exactly and is never edited. Human edits change `fields` / `fieldStatus` (edited fields get `edited: true`), so the approval `Review` can show precisely what a person changed relative to the model.

## Confidence

Per-field confidence is **the model's qualitative estimate** and is displayed as High / Medium / Low / Unknown. It is not a calibrated probability, is never turned into a percentage, and never bypasses validation or review. `overallConfidence` on a workflow is the weakest of the required fields plus the time window (`validation/rules.ts`).

## Validation and business rules

Deterministic and independent of the model (`validation/delivery.ts`): required fields; calendar-valid, non-past dates (with same-day, Sunday and far-future warnings); positive quantities, whole numbers for discrete units, unusually large quantities; address must contain a street number and name, PO boxes are refused, missing locality warns; time range order and width, business hours; phone digit count; suspected duplicates (same customer + normalised address + date among the user's non-rejected workflows); allowed workflow type.

Issues are `error` (blocks approval) or `warning` (needs a look). `decideReview` then combines AI flags, ambiguities, warnings, weak fields and errors into `needsAttention` and a list of reasons. **It never approves anything.**

## Prompt-injection model

| Attack | Defence |
| --- | --- |
| "Ignore previous instructions…" in the document | Instructions only in the system prompt; document delimited and declared untrusted; model reports it as an ambiguity |
| Document closes the data block (`</document>`) | Delimiter tags are neutralised before prompting |
| Model output smuggles extra fields / URLs | Strict schema; unknown keys reject the whole reply |
| Model fabricates evidence to look confident | Evidence must appear in the source; otherwise downgraded |
| Model says "approved / auto-execute" | The model has no such field; approval is a human act; execution needs a persisted `Review` |
| Data exfiltration through tools | Exactly one tool (`record_extraction`) that only returns data to OpsFlow; no network or file tools |
| Hostile text rendered in the UI | React escaping; source shown in `<pre>`; no `dangerouslySetInnerHTML` (tested) |

The mock provider mirrors the contract and additionally flags instruction-like text; the same mechanism is asserted in tests.

## Providers

`AIProvider` = `{ name, isMock, extract(request, { signal }) }`. `ClaudeProvider` takes an injected `MessagesClient` (the slice of the SDK it uses), which is how the tests cover it without network access. `getAIProvider()` never falls back silently: `AI_PROVIDER=claude` without a key is an error.

**Not verified here:** behaviour against the live API. The prompt and schema should be evaluated on real, labelled requests before relying on them.
