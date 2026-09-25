# AI pipeline

## Goals

1. Get useful structure out of messy text.
2. Never let the model *decide* anything consequential — including whether its own output is trustworthy.
3. Make uncertainty first-class (known / inferred / ambiguous / missing).
4. Treat the document — and the model's reply — as untrusted input.
5. Keep spend bounded and visible.

## Stages

```text
PDF? → worker thread (timeout) ─┐
text ─► clean & limit ─► reserve budget ─► provider.extract() ─► strict schema ─► reconcile (verify evidence) ─► validate ─► store
            │                  │                 │                    │                    │
       control chars     per-user, atomic   timeout, retry     unknown fields       field-scoped, deterministic;
       length ≤ 20k                        classify errors     are rejected         the pipeline decides review
```

### 1. Input handling

Uploads are inspected on the request path (size, magic bytes, UTF-8) and **PDFs are parsed later, in a background job, inside an isolated worker thread** with a wall-clock timeout, a memory cap, a 25-page cap and a pool of two (`documents/pdf-worker.ts`). `cleanText` normalises newlines and removes control, zero-width and bidirectional-override characters. Empty input and input over 20,000 characters are rejected before any model call.

### 2. Budget (`ai/usage.ts`)

Before every provider request a slot is **reserved**: under a per-user advisory lock the daily request/token budgets (and the optional monthly cost budget) are checked and a placeholder `AiUsage` row is inserted in the same transaction, so concurrent jobs cannot all pass the check and overshoot. After the call the row is completed with provider, model, success, tokens and — *only if prices are configured and the provider reported tokens* — an estimated cost. Nothing is fabricated: the mock provider reports no tokens, so its cost is unknown, not zero. Failed and retried requests count (providers bill for them). Exhausting a budget fails the workflow immediately with an explanation and no retry.

### 3. Prompt (`ai/prompt.ts`)

- **All instructions are in the system prompt**, including an explicit statement that the document is untrusted data and that instruction-like text inside it must be ignored and reported as an ambiguity.
- The document goes in the user turn inside `<document>…</document>`, with the reference date in `<reference_date>`. `escapeDocument` breaks any `<document>`, `<system>` or similar tag in the text so it cannot close or spoof the delimiters.
- The model must respond **only** by calling `record_extraction`; `tool_choice` forces it. The tool's JSON Schema is generated from the Zod schema (`z.toJSONSchema`), so the contract exists in exactly one place.
- `temperature: 0`, `max_tokens: 2048`, SDK retries disabled (the pipeline owns retry policy).

### 4. Schema (`ai/schema.ts`)

Every object is `.strict()`. The reply contains `fields`; a `field_assessments` entry **per field** (`status` known/inferred/missing/ambiguous, `confidence`, a short verbatim `evidence` quote, a `note`); `missing_information[]`; `ambiguities[]`; and the model's own `requires_human_review` / `recommended_action` / `reason` — which are *advisory only* (see stage 6). Any extra key anywhere, a bad date format, an over-long string, or a missing assessment fails validation and triggers the retry policy.

### 5. Retry policy

Up to 2 attempts per job attempt, 30 s timeout each. A schema failure retries once with **structural feedback only** (paths and codes, never model-produced values). Provider errors are classified (`timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`); `ExtractionError.retryable` tells the job layer whether trying again later is sensible (outages/timeouts: yes, with backoff up to `JOB_MAX_ATTEMPTS`; auth/bad request/malformed output/budget: no). Users see a **user-safe** message; the provider's own message stays in logs.

### 6. Reconciliation: deterministic evidence verification (`ai/evidence.ts`, `ai/extract.ts`)

The model proposes a value **and** a quote. OpsFlow never accepts the model's word that the quote is valid. For every field that has a value:

1. The quote must be **meaningful**: not empty, not only stop-words / generic field words ("the", "address", "customer", "please", "hi"…).
2. The quote must be **found in the document** (whitespace/case tolerant). OpsFlow — not the model — computes the source **span** (`{start,end}`), stored with the assessment.
3. The quote must **support that field's value**, with field-specific rules:
   - `customer`: the normalised customer name appears in the quote;
   - `address`: the street number and street name appear in the quote;
   - `requested_date`: the quote *resolves* (with the same deterministic date parser the mock uses) to the extracted date;
   - times / window: the quote contains that clock time / the window word;
   - `items`: at least one item's quantity and description are in the quote, and *every* item is present in the document;
   - `contact_name` / `contact_phone` / `special_instructions`: the name, the phone digits, or ≥60 % of the instruction words appear in the quote.

Failing any check **downgrades** the field to `ambiguous / low`, clears the evidence, marks it `verified: false`, adds an ambiguity ("Unverified: …") and appends a note. Verified fields carry `verified: true` and their span. Status/value contradictions are also repaired (a value marked "missing" becomes `inferred/low`; "known" with no value becomes `missing`).

Then the pipeline **takes over the review decision**: `requires_human_review` becomes true if the model said so *or* anything is unverified, ambiguous, missing or instruction-like; `recommended_action` is recomputed (`request_more_information` if a required field is missing, else `review`, else `approve`). A model that claims "all fields verified, high confidence, no ambiguities, approve" therefore cannot remove a workflow from the *Attention required* list or improve its overall confidence — tested end to end with a fully obedient, forged response.

### 7. Storage

`ExtractedData.aiOutput` holds the reconciled reply and is never edited. Human edits change `fields` / `fieldStatus` (edited fields get `edited: true`), and bump the workflow **version**, so the approval `Review` can show exactly what a person changed and approval can be tied to the version they saw.

## Confidence

Per-field confidence is **the model's qualitative estimate** (High/Medium/Low/Unknown) and is displayed as such; it is not a calibrated probability and is never turned into a percentage. Unverified claims are capped at Low. `overallConfidence` is the weakest of the required fields plus the time window.

## Validation and business rules

Deterministic and independent of the model (`validation/delivery.ts`): required fields; calendar-valid, non-past dates (same-day, Sunday and far-future warnings); positive quantities, whole numbers for discrete units, unusually large quantities; address must contain a street number and name, PO boxes refused, missing locality warns; time range order/width and business hours; phone digit count; suspected duplicates; allowed workflow type. `decideReview` combines AI flags, ambiguities, warnings, weak fields and errors into `needsAttention` and reasons. **It never approves anything.**

**Duplicates** use normalised keys stored on the workflow (`customerKey`, `addressKey`, `deliveryDate`): customer names are Unicode-folded, lower-cased, stripped of punctuation and trailing legal suffixes (Ltd, Inc, Corp, LLC, Limited…), so "ABC Building Supplies Ltd." matches "abc building supplies"; addresses normalise street types, directions and provinces (St/Street, ON/Ontario). The lookup is an exact match on the composite index `(userId, customerKey, deliveryDate)` with no row cap — a frequent customer's hundreds of orders cannot hide a duplicate. There is deliberately no fuzzy matching: results are reproducible.

## Prompt-injection model

| Attack | Defence |
| --- | --- |
| "Ignore previous instructions…" in the document | Instructions only in the system prompt; document delimited and declared untrusted; the model reports it; a heuristic also flags it independently of the model |
| Document closes the data block (`</document>`) | Delimiter tags are neutralised before prompting |
| Model output smuggles extra fields / URLs | Strict schema; unknown keys reject the whole reply |
| Model fabricates or misuses evidence to look confident | Deterministic, field-scoped verification with real source spans; unsupported claims are downgraded |
| Model (obediently) reports "verified, no ambiguity, approve" | The pipeline decides review; forged confidence cannot bypass triage (tested end to end) |
| Model says "approved / auto-execute" | No such field; approval is a human act bound to a version; execution needs a persisted `Review` |
| Data exfiltration through tools | Exactly one tool that only returns data to OpsFlow; no network or file tools |
| Hostile text rendered in the UI | React escaping; source shown in `<pre>`; no `dangerouslySetInnerHTML` (tested) |
| Cost exhaustion | Per-user atomic budgets; rate limits; PDF and input size caps |

## Providers

`AIProvider` = `{ name, isMock, extract(request, { signal }) }`. `ClaudeProvider` takes an injected `MessagesClient`, which is how the tests cover it without network access. `getAIProvider()` never falls back silently: `AI_PROVIDER=claude` without a key throws `ProviderConfigError`, which the job layer reports as a clear, terminal "not configured correctly" failure.

**Not verified here:** behaviour against the live API. The prompt, schema and the evidence rules should be evaluated on real, labelled requests before relying on them — in particular, the evidence rules are strict by design and a real model may need prompt tuning to quote precisely.
