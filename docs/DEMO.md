# Demo guide

Total time: about five minutes. No API key or external service is needed.

## Setup (once)

```bash
npm install && npm run setup     # note the demo password it prints
npm run db:start                 # terminal 1
npm run db:deploy && npm run db:seed && npm run dev     # terminal 2
```

Open <http://localhost:3000> and sign in as `demo@opsflow.test`. The amber banner confirms **demo mode**: a deterministic mock extractor, simulated actions. `npm run dev` also starts the in-process job worker, so submitted requests are processed in the background (and the page refreshes itself while it waits).

## The story in five steps

1. **Dashboard** — KPIs (7 workflows: 1 completed, 1 failed, 4 pending review, 1 rejected), *Attention required* with the reason each item needs a person and **how long it has been waiting** (turns amber after 24 h, "Overdue" after 72 h), simulated *review notifications*, recent activity, and the filterable table.
2. **New workflow → Paste text → "Delivery with ambiguous time" → Extract and validate.** This is the request from the brief: *"…4 pallets of roofing shingles to 125 King Street, London Ontario this Friday morning… call Mike"*.
3. **Review screen** — point out:
   - the date was *inferred* from "this Friday", with the quote it came from (**OpsFlow verified that quote against the document** — the model cannot vouch for itself);
   - the time is **Ambiguous / Medium**: "morning" is not a delivery time — and the AI did not invent one;
   - the contact is **Low**: a name but no phone number;
   - validation shown was computed *just now*, and the header says how long the request has been waiting.
4. **Edit request** — set start 09:00, end 11:00, add a phone number, **Save**. The timeline shows the edit with before → after values; the version increments; validation re-ran and the warning cleared.
5. **Approve** — the workflow completes. The *Automated action* card shows the generated confirmation (`Time: 9:00 AM – 11:00 AM`) marked **SIMULATED — no message was sent**. *Review* shows what changed from the AI output; the *Timeline* is the audit trail.

## The two-tab attack (approval is bound to the version you saw)

Open the same *Review required* workflow in **two browser tabs**. In tab B, edit the address and save. In tab A (still showing the old address), click **Approve**: it is **refused** with *"This request changed while you were reviewing"*, nothing is approved or sent, and **Load the latest version** shows the new address. Approving that version executes exactly what was reviewed. (Automated version: `node scripts/e2e-smoke.mjs`.)

## More things worth showing

| Scenario | How | What it demonstrates |
| --- | --- | --- |
| Missing information | Open **Harbour Roofing** | No address → validation *error*; **Approve is disabled** and the server would refuse anyway; edit in the address to unblock |
| Unverified evidence | New workflow → *Contains injected instructions* | Instruction-like text is flagged and treated as data; nothing auto-approves; forged confidence cannot hide it from *Attention required* |
| Low-confidence / ambiguous date | Open **Maple Leaf Homes** | `03/04/2027` is flagged ambiguous instead of guessed |
| Failed action | Open **Lakeshore Concrete** | Simulated outage recorded as a failed action; **Retry action** completes it with the *same* idempotency key — no double send |
| Rejected duplicate | Filter *Rejected* | Duplicate detection (normalised names: "ABC Building Supplies **Ltd**" matches) + terminal rejection |
| Background recovery | Kill the server mid-request, restart | After the job lease expires (default 2 min) the sweeper re-queues the workflow and it finishes; nothing is stuck |
| AI usage | **AI usage** in the sidebar | Every request recorded; cost shown only when tokens and prices are known — the mock reports none, so it says "not available" instead of "$0" |
| Your data | **Integrations → Your data** | Download a JSON export; delete-account flow (password + typing DELETE) |
| Upload | New workflow → *Upload document* with a `.txt` or text-based PDF | Content sniffing; PDF parsed in an isolated worker thread |
| Tenant isolation | Register a second account in a private window and try a workflow URL from the first | 404 — not "forbidden", not visible |
| Webhook | *Integrations* → create credential → `node scripts/send-webhook.mjs` (see [N8N.md](N8N.md)) | Signed request → workflow appears as *Webhook*; sending the same text twice within 5 minutes returns the original (`duplicate: true`) |
| Replay attack | `node scripts/verify-audit-fixes.mjs` | The audit's exploits (rotated idempotency keys, lock-out of a victim's public key id) fail |

## Using a real model

Set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY` in `.env` and restart. The banner disappears and AI cards show `Claude · <model>`; token usage and (with `AI_PRICE_*` set) estimated cost appear on **AI usage**. Everything else is identical, which is the point of the provider interface. (See the README limitations: this path is tested against a fake client, not the live API.)

## Reset

`npm run db:seed` rebuilds the demo user's workflows from scratch (using the explicit audit-maintenance path, demo data only) and issues a new demo webhook credential.
