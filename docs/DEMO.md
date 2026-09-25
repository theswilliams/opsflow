# Demo guide

Total time: about five minutes. No API key or external service is needed.

## Setup (once)

```bash
npm install && npm run setup     # note the demo password it prints
npm run db:start                 # terminal 1
npm run db:deploy && npm run db:seed && npm run dev     # terminal 2
```

Open <http://localhost:3000> and sign in as `demo@opsflow.test`. The amber banner confirms **demo mode**: a deterministic mock extractor, simulated actions.

## The story in five steps

1. **Dashboard** — KPIs (7 workflows: 1 completed, 1 failed, 4 pending review, 1 rejected), *Attention required* with the reason each item needs a person, recent activity from the audit log, and the filterable table (try filtering by *Review required*).
2. **New workflow → Paste text → "Delivery with ambiguous time" → Extract and validate.** This is the request from the brief: *"…4 pallets of roofing shingles to 125 King Street, London Ontario this Friday morning… call Mike"*.
3. **Review screen** — point out:
   - the date was *inferred* from "this Friday" (with the quote it came from);
   - the time is **Ambiguous / Medium**: "morning" is not a delivery time — and the AI did not invent one;
   - the contact is **Low**: a name but no phone number;
   - the amber box explaining why a person must look at it.
4. **Edit request** — set start 09:00, end 11:00, add a phone number, **Save**. The timeline now shows *"Edited items, contact phone, requested time…"* with before → after values; validation re-ran and the time warning cleared; the time row now reads **Stated / High** (edited by reviewer).
5. **Approve** — the workflow completes. The *Automated action* card shows the generated customer confirmation (`Time: 9:00 AM – 11:00 AM`) marked **SIMULATED — no message was sent**. *Review* shows what changed from the AI output, and the *Timeline* is the full audit trail.

## More things worth showing

| Scenario | How | What it demonstrates |
| --- | --- | --- |
| Missing information | Open **Harbour Roofing** | No address → validation *error*; **Approve is disabled** and the server would refuse anyway; edit in the address to unblock |
| Low-confidence / ambiguous date | Open **Maple Leaf Homes** | `03/04/2027` is flagged ambiguous instead of guessed |
| Failed action | Open **Lakeshore Concrete** | Simulated outage recorded as a failed action; **Retry action** completes it without a double execution |
| Rejected duplicate | Filter *Rejected* | Duplicate detection + rejection is terminal |
| Prompt injection | New workflow → *Contains injected instructions* | The hostile line is treated as data, reported as an ambiguity, nothing auto-approves |
| Upload | New workflow → *Upload document* with a `.txt` or text-based PDF | Content sniffing, PDF text extraction |
| Tenant isolation | Register a second account in a private window and try a workflow URL from the first | 404 — not "forbidden", not visible |
| Webhook | *Integrations* → create credential → run `node scripts/send-webhook.mjs` (see [N8N.md](N8N.md)) | Signed request → workflow appears in the dashboard as *Webhook* |
| Bad signature | Change one character of the secret and resend | Uniform `401`, and a *"Webhook request rejected"* event in the audit trail |

## Using a real model

Set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY` in `.env` and restart. The banner disappears and AI cards show `Claude · <model>`. Everything else is identical, which is the point of the provider interface. (See the limitations in the README: this path is tested against a fake client, not the live API.)

## Reset

`npm run db:seed` rebuilds the demo user's workflows from scratch (and issues a new demo webhook credential).
