// Re-runs the audit's network-level exploits against a RUNNING server and prints what happens.
//
//   OPSFLOW_KEY_ID=… OPSFLOW_SECRET=… node scripts/verify-audit-fixes.mjs [base-url]
//
// For the client-isolation checks, start the server with TRUSTED_PROXIES=127.0.0.1 so this script (on the same
// machine) can play several distinct clients via X-Forwarded-For.
import { createHmac } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";
const keyId = process.env.OPSFLOW_KEY_ID;
const secret = process.env.OPSFLOW_SECRET;
if (!keyId || !secret) {
  console.error("Set OPSFLOW_KEY_ID and OPSFLOW_SECRET.");
  process.exit(2);
}

const nowSec = () => String(Math.floor(Date.now() / 1000));
const sign = (ts, body, idem = "") => "sha256=" + createHmac("sha256", secret).update(["v1", ts, idem, body].join("\n")).digest("hex");
const text = (n) => `Customer: Verify ${n} Ltd\nDeliver 2 pallets of brick to ${100 + n} Main Street, Toronto, Ontario on 2030-01-15 at 9am. Call Sam 519-555-0100.`;
const payload = (n) => JSON.stringify({ type: "delivery_request", text: text(n) });

/** Sends a request with explicit control over every signed element. */
async function send(raw, { ts = nowSec(), sig, idem, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", "X-OpsFlow-Key-Id": keyId, "X-OpsFlow-Timestamp": ts, "X-OpsFlow-Signature": sig ?? sign(ts, raw, idem ?? ""), ...headers };
  if (idem) h["Idempotency-Key"] = idem;
  const res = await fetch(`${base}/api/webhooks/workflow`, { method: "POST", headers: h, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// F1 — replay --------------------------------------------------------------------------------------------------
{
  const raw = payload(1);
  const ts = nowSec();
  const captured = sign(ts, raw); // the victim's request: signed with no idempotency key
  const rotated = [];
  for (let i = 0; i < 5; i++) rotated.push((await send(raw, { ts, sig: captured, idem: `attack-${i}` })).status);
  check("F1  captured request replayed under 5 rotated Idempotency-Keys", rotated.every((s) => s === 401), `statuses ${JSON.stringify(rotated)}  (audit reproduced [201,201,201,201,201])`);

  const first = await send(raw, { ts, sig: captured });
  const replay = await send(raw, { ts, sig: captured });
  check("F1  the original works once; an exact replay returns the same workflow", first.status === 201 && replay.status === 200 && first.body.id === replay.body.id, `${first.status}/${replay.status}`);

  const k1 = await send(payload(2), { idem: "k-1" });
  const k2 = await send(payload(2), { idem: "k-2" });
  check("F1  identical content re-signed under a different key does not create a 2nd workflow", k1.status === 201 && k2.status === 200 && k1.body.id === k2.body.id, `${k1.status}/${k2.status}`);

  check("F1  expired timestamp rejected", (await send(payload(3), { ts: String(Number(nowSec()) - 3600) })).status === 401);
  check("F1  far-future timestamp rejected", (await send(payload(3), { ts: String(Number(nowSec()) + 3600) })).status === 401);

  const raw5 = payload(5);
  const ts5 = nowSec();
  const sig5 = sign(ts5, raw5);
  const race = await Promise.all(Array.from({ length: 8 }, () => send(raw5, { ts: ts5, sig: sig5 })));
  check("F1  8 concurrent identical requests produce one workflow", new Set(race.map((r) => r.body.id)).size === 1 && race.filter((r) => r.status === 201).length === 1, race.map((r) => r.status).join(","));
}

// F2 — client isolation ---------------------------------------------------------------------------------------
{
  const attacker = "198.51.100.66";
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await send("{}", { sig: "sha256=bad", headers: { "X-Forwarded-For": `10.9.9.${i}, ${attacker}` } })).status);
  const n401 = statuses.filter((s) => s === 401).length;
  const n429 = statuses.filter((s) => s === 429).length;
  check("F2  attacker (forging the LEFT of X-Forwarded-For) throttles only themselves", n401 === 20 && n429 === 10, `${n401}×401 then ${n429}×429`);

  const victim = await send(payload(6), { headers: { "X-Forwarded-For": "203.0.113.7" } });
  check("F2  victim using the same PUBLIC key id from another address is not locked out", victim.status === 201, `status ${victim.status}  (audit reproduced 429)`);
  const noHeader = await send(payload(7));
  check("F2  a valid request with no forwarding header is unaffected too", noHeader.status === 201, `status ${noHeader.status}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
