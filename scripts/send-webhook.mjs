// Sends a correctly signed request to the OpsFlow webhook — handy for demos and smoke tests.
//
//   OPSFLOW_KEY_ID=ofk_… OPSFLOW_SECRET=ofs_… node scripts/send-webhook.mjs [base-url] [text-file]
//   OPSFLOW_KEY_ID=ofk_… OPSFLOW_SECRET=ofs_… node scripts/send-webhook.mjs --status <workflow-id> [base-url]
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const keyId = process.env.OPSFLOW_KEY_ID;
const secret = process.env.OPSFLOW_SECRET;
if (!keyId || !secret) {
  console.error("Set OPSFLOW_KEY_ID and OPSFLOW_SECRET (create them under Integrations in the app).");
  process.exit(1);
}

const args = process.argv.slice(2);
const statusIdx = args.indexOf("--status");
const sign = (body) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "X-OpsFlow-Key-Id": keyId, "X-OpsFlow-Timestamp": ts, "X-OpsFlow-Signature": `sha256=${sig}` };
};

let res;
if (statusIdx >= 0) {
  const id = args[statusIdx + 1];
  const base = args.find((a, i) => i !== statusIdx && i !== statusIdx + 1) ?? "http://localhost:3000";
  res = await fetch(`${base}/api/webhooks/workflow/${encodeURIComponent(id)}`, { headers: sign("") });
} else {
  const base = args[0] ?? "http://localhost:3000";
  const text = args[1]
    ? readFileSync(args[1], "utf8")
    : "Customer: ABC Building Supplies\n\nCan you deliver 4 pallets of roofing shingles to 125 King Street, London Ontario this Friday morning?\nPlease call Mike when the driver is on the way.";
  const body = JSON.stringify({ type: "delivery_request", text, external_id: `demo-${Date.now()}` });
  res = await fetch(`${base}/api/webhooks/workflow`, { method: "POST", headers: { "Content-Type": "application/json", ...sign(body) }, body });
}
console.log(res.status, JSON.stringify(await res.json(), null, 2));
