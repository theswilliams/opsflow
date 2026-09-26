// Generates n8n/opsflow-workflow.json (an importable n8n workflow).
// Run: node scripts/build-n8n-workflow.mjs
// The JavaScript that n8n executes lives here as plain strings so tests can run the exact same code.
import { writeFileSync } from "node:fs";

export const SIGN_REQUEST_CODE = [
  "// Builds the exact JSON body and signs it (scheme v1): HMAC-SHA256(secret, 'v1' LF timestamp LF idempotency-key LF body).",
  "const crypto = require('crypto');",
  "const input = $json.body ?? $json;",
  "const text = String(input.text ?? '');",
  "// STABLE idempotency: prefer the upstream system's own id (e.g. the email Message-ID). Otherwise derive it from the",
  "// content, so a repeated trigger for the same message returns the same OpsFlow workflow instead of creating a",
  "// duplicate (the n8n execution id changes on every run and must NOT be used for this).",
  "const externalId = String(input.external_id ?? input.message_id ?? crypto.createHash('sha256').update(text).digest('hex').slice(0, 32));",
  "const body = JSON.stringify({ type: 'delivery_request', text, external_id: externalId });",
  "const timestamp = String(Math.floor(Date.now() / 1000));",
  "// external_id lives inside the signed body; no separate Idempotency-Key header is sent, so its slot is empty.",
  "const message = ['v1', timestamp, '', body].join('\\n');",
  "const signature = 'sha256=' + crypto.createHmac('sha256', $env.OPSFLOW_SECRET).update(message).digest('hex');",
  "return { json: { body, timestamp, signature, keyId: $env.OPSFLOW_KEY_ID } };",
].join("\n");

export const SIGN_STATUS_CODE = [
  "// GET requests are signed over an empty body and an empty idempotency-key slot.",
  "const crypto = require('crypto');",
  "const timestamp = String(Math.floor(Date.now() / 1000));",
  "const message = ['v1', timestamp, '', ''].join('\\n');",
  "const signature = 'sha256=' + crypto.createHmac('sha256', $env.OPSFLOW_SECRET).update(message).digest('hex');",
  "return { json: { timestamp, signature, keyId: $env.OPSFLOW_KEY_ID } };",
].join("\n");

const note = (name, content, position, width = 300, height = 160) => ({
  parameters: { content, width, height },
  name,
  type: "n8n-nodes-base.stickyNote",
  typeVersion: 1,
  position,
});

const nodes = [
  note(
    "About this workflow",
    "## OpsFlow intake\nReceives a messy request, submits it to OpsFlow (AI extraction + validation), then **waits for a person to approve it in OpsFlow** before notifying.\n\nRequires n8n env vars: `OPSFLOW_URL`, `OPSFLOW_KEY_ID`, `OPSFLOW_SECRET`, and `NODE_FUNCTION_ALLOW_BUILTIN=crypto`. Never paste the secret into a node.",
    [-40, -200],
    420,
    170,
  ),
  {
    parameters: { httpMethod: "POST", path: "opsflow-intake", responseMode: "onReceived", options: {} },
    name: "Incoming Request",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 0],
    webhookId: "opsflow-intake",
  },
  {
    parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: SIGN_REQUEST_CODE },
    name: "Sign request",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [220, 0],
  },
  {
    parameters: {
      method: "POST",
      url: "={{ $env.OPSFLOW_URL }}/api/webhooks/workflow",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-OpsFlow-Key-Id", value: "={{ $json.keyId }}" },
          { name: "X-OpsFlow-Timestamp", value: "={{ $json.timestamp }}" },
          { name: "X-OpsFlow-Signature", value: "={{ $json.signature }}" },
        ],
      },
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ $json.body }}",
      options: { response: { response: { neverError: true } }, timeout: 90000 },
    },
    name: "Submit to OpsFlow",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [440, 0],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: "loose" },
        conditions: [
          { id: "accepted", leftValue: "={{ $json.id }}", rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } },
        ],
        combinator: "and",
      },
    },
    name: "Accepted?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [660, 0],
  },
  {
    parameters: {},
    name: "Alert: OpsFlow rejected the request",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [880, 140],
  },
  {
    parameters: { amount: 30, unit: "seconds" },
    name: "Wait for human review",
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position: [880, -60],
    webhookId: "opsflow-wait",
  },
  {
    parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: SIGN_STATUS_CODE },
    name: "Sign status request",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1100, -60],
  },
  {
    parameters: {
      url: "={{ $env.OPSFLOW_URL }}/api/webhooks/workflow/{{ $('Submit to OpsFlow').item.json.id }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-OpsFlow-Key-Id", value: "={{ $json.keyId }}" },
          { name: "X-OpsFlow-Timestamp", value: "={{ $json.timestamp }}" },
          { name: "X-OpsFlow-Signature", value: "={{ $json.signature }}" },
        ],
      },
      options: { response: { response: { neverError: true } } },
    },
    name: "Get status",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1320, -60],
  },
  {
    parameters: {
      rules: {
        values: ["COMPLETED", "REJECTED", "FAILED"].map((status, i) => ({
          conditions: {
            options: { caseSensitive: true, typeValidation: "strict" },
            conditions: [{ id: `s${i}`, leftValue: "={{ $json.status }}", rightValue: status, operator: { type: "string", operation: "equals" } }],
            combinator: "and",
          },
          renameOutput: true,
          outputKey: status,
        })),
      },
      options: { fallbackOutput: "extra" },
    },
    name: "Review outcome",
    type: "n8n-nodes-base.switch",
    typeVersion: 3.2,
    position: [1540, -60],
  },
  {
    parameters: {},
    name: "Notify: confirmation ready (use $json.confirmation)",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [1780, -200],
  },
  {
    parameters: {},
    name: "Notify: request rejected",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [1780, -60],
  },
  {
    parameters: {},
    name: "Alert: workflow failed (see $json.failure_reason)",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [1780, 80],
  },
  note(
    "Notification placeholders",
    "Replace the three NoOp nodes on the right with your Slack / Email / SMS nodes. `data` in the status response contains the reviewed, approved fields and is only released after a person approves.",
    [1760, 200],
    340,
    140,
  ),
];

const link = (node, index = 0) => ({ node, type: "main", index });
const connections = {
  "Incoming Request": { main: [[link("Sign request")]] },
  "Sign request": { main: [[link("Submit to OpsFlow")]] },
  "Submit to OpsFlow": { main: [[link("Accepted?")]] },
  "Accepted?": { main: [[link("Wait for human review")], [link("Alert: OpsFlow rejected the request")]] },
  "Wait for human review": { main: [[link("Sign status request")]] },
  "Sign status request": { main: [[link("Get status")]] },
  "Get status": { main: [[link("Review outcome")]] },
  "Review outcome": {
    main: [
      [link("Notify: confirmation ready (use $json.confirmation)")],
      [link("Notify: request rejected")],
      [link("Alert: workflow failed (see $json.failure_reason)")],
      [link("Wait for human review")],
    ],
  },
};

export const workflow = {
  name: "OpsFlow — intake, review and notify",
  nodes,
  connections,
  active: false,
  settings: { executionOrder: "v1", executionTimeout: 172800 },
  pinData: {},
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("build-n8n-workflow.mjs")) {
  writeFileSync("n8n/opsflow-workflow.json", JSON.stringify(workflow, null, 2) + "\n");
  console.log("Wrote n8n/opsflow-workflow.json");
}
