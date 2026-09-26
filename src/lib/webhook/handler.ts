import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_INPUT_CHARS } from "@/lib/ai/extract";
import type { ExtractedFields } from "@/lib/ai/schema";
import { encryptSecret, sha256 } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { runJobInline } from "@/lib/jobs/worker";
import { logger } from "@/lib/logger";
import { clientIpFromRequest } from "@/lib/net/client-ip";
import { RateLimiter } from "@/lib/rate-limit";
import { AUDIT, recordAudit } from "@/lib/workflow/audit";
import { defaultDeps, type WorkflowDeps } from "@/lib/workflow/core";
import { WorkflowError } from "@/lib/workflow/errors";
import { createWorkflow } from "@/lib/workflow/service";
import { decryptCredentialSecret, findActiveCredentialRow } from "./credentials";
import { verifySignature } from "./signature";

export const MAX_BODY_BYTES = 64 * 1024;

const envNumber = (key: "WEBHOOK_KEY_LIMIT_PER_MIN" | "WEBHOOK_TENANT_LIMIT_PER_MIN", fallback: number) => () => {
  try {
    return getEnv()[key];
  } catch {
    return fallback;
  }
};

/**
 * Abuse controls. Design rules (see docs/SECURITY.md):
 *  - A VALID signature is never rejected because of anybody else's traffic. The failure limiter is consulted
 *    only for requests that fail authentication, and is keyed by the client address — an attacker can only
 *    ever throttle themselves. When the client address is unknown the failure limiter is not applied at all
 *    (unknown is not "everybody").
 *  - Capacity limits for authenticated traffic are per credential AND per tenant, so one tenant can never
 *    consume another's capacity, and minting more credentials cannot multiply a tenant's allowance.
 *  - In-memory, per process. Multi-instance deployments need a shared store.
 */
export const limiters = {
  /** Counts failed authentications per client address (only consulted for failing clients). */
  failedAuth: new RateLimiter(20, 60_000),
  key: new RateLimiter(envNumber("WEBHOOK_KEY_LIMIT_PER_MIN", 60), 60_000),
  tenant: new RateLimiter(envNumber("WEBHOOK_TENANT_LIMIT_PER_MIN", 120), 60_000),
  auditThrottle: new RateLimiter(3, 3_600_000),
};

export function resetWebhookLimiters() {
  Object.values(limiters).forEach((l) => l.reset());
}

const IDEMPOTENCY = /^[\w.:@-]{1,200}$/;

export const payloadSchema = z
  .object({
    type: z.literal("delivery_request"),
    text: z.string().min(1).max(MAX_INPUT_CHARS),
    external_id: z.string().regex(IDEMPOTENCY).optional(),
  })
  .strict();

type Json = Record<string, unknown>;
interface Handled {
  status: number;
  body: Json;
  headers?: Record<string, string>;
}

const err = (status: number, code: string, message: string, extra: Json = {}, headers?: Record<string, string>): Handled => ({
  status,
  body: { error: { code, message, ...extra } },
  headers,
});

export function toResponse(h: Handled, requestId: string): Response {
  return new Response(JSON.stringify(h.body), {
    status: h.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId, ...h.headers },
  });
}

type BodyResult = { ok: true; text: string } | { ok: false };

/** Reads at most `max` bytes; aborts the stream as soon as the limit is exceeded. */
export async function readBodyLimited(request: Request, max: number): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return { ok: false };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

const UNAUTHORIZED = () => err(401, "unauthorized", "Missing or invalid credentials.");

let dummyCiphertext: string | undefined;
/** A real ciphertext to decrypt when the key id is unknown, so known and unknown ids do the same work. */
const dummy = () => (dummyCiphertext ??= encryptSecret("ofs_dummy_secret_for_constant_work"));

type AuthResult = { ok: true; userId: string; keyId: string; credentialId: string } | { ok: false; response: Handled };

async function authenticate(request: Request, rawBody: string, deps: WorkflowDeps, ip: string | null): Promise<AuthResult> {
  const keyId = request.headers.get("x-opsflow-key-id");
  const idempotencyKey = request.headers.get("idempotency-key");
  const row = keyId && keyId.length < 100 ? await findActiveCredentialRow(deps.db, keyId) : null;
  // Identical work whether or not the key exists: one decrypt and one HMAC either way.
  const secret = decryptCredentialSecret(row?.encryptedSecret ?? dummy());
  const check = verifySignature({
    secret,
    timestamp: request.headers.get("x-opsflow-timestamp"),
    signature: request.headers.get("x-opsflow-signature"),
    rawBody,
    idempotencyKey,
  });

  if (!row || !check.ok) {
    if (ip) limiters.failedAuth.hit(ip);
    const reason = !row ? "unknown_key" : check.ok ? "unknown_key" : check.reason;
    logger.warn("webhook.auth_failed", { keyId, reason });
    if (row && limiters.auditThrottle.check(row.keyId).allowed) {
      // Off the response path, so this extra write cannot become a timing side channel for "key exists".
      void recordAudit(deps.db, {
        userId: row.userId,
        actor: { type: "WEBHOOK", id: row.keyId },
        eventType: AUDIT.WEBHOOK_REJECTED,
        message: `Webhook request rejected (${reason} signature)`,
        metadata: { reason },
      }).catch(() => undefined);
    }
    return { ok: false, response: UNAUTHORIZED() };
  }
  return { ok: true, userId: row.userId, keyId: row.keyId, credentialId: row.id };
}

type Preflight = { ok: true; auth: Extract<AuthResult, { ok: true }>; rawBody: string } | { ok: false; response: Handled };

async function preflight(request: Request, deps: WorkflowDeps, needsBody: boolean): Promise<Preflight> {
  const fail = (response: Handled): Preflight => ({ ok: false, response });
  const ip = clientIpFromRequest(request.headers);

  // Only clients that have been failing authentication are ever blocked here.
  if (ip) {
    const blocked = limiters.failedAuth.peek(ip);
    if (!blocked.allowed) return fail(err(429, "rate_limited", "Too many failed attempts.", {}, { "retry-after": String(blocked.retryAfterSeconds) }));
  }
  if (needsBody && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return fail(err(415, "unsupported_media_type", "Content-Type must be application/json."));
  }
  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return fail(err(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes.`));

  const auth = await authenticate(request, body.text, deps, ip);
  if (!auth.ok) return fail(auth.response);

  // Authenticated capacity: per tenant first (so a tenant cannot exceed its share by spreading over credentials).
  const tenant = limiters.tenant.check(auth.userId);
  if (!tenant.allowed) return fail(err(429, "rate_limited", "Tenant rate limit exceeded.", {}, { "retry-after": String(tenant.retryAfterSeconds) }));
  const key = limiters.key.check(auth.keyId);
  if (!key.allowed) return fail(err(429, "rate_limited", "Rate limit exceeded.", {}, { "retry-after": String(key.retryAfterSeconds) }));
  void deps.db.apiCredential.update({ where: { id: auth.credentialId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { ok: true, auth, rawBody: body.text };
}

/** POST /api/webhooks/workflow */
export async function handleWorkflowPost(request: Request, getDeps: () => WorkflowDeps = defaultDeps): Promise<Response> {
  const requestId = randomUUID();
  const started = Date.now();
  let deps: WorkflowDeps;
  try {
    deps = getDeps();
  } catch (e) {
    logger.error("webhook.misconfigured", { requestId, error: e });
    return toResponse(err(503, "service_unavailable", "The service is temporarily unavailable."), requestId);
  }

  try {
    const pre = await preflight(request, deps, true);
    if (!pre.ok) return toResponse(pre.response, requestId);
    const { auth, rawBody } = pre;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return toResponse(err(400, "invalid_json", "Request body is not valid JSON."), requestId);
    }
    const payload = payloadSchema.safeParse(parsedJson);
    if (!payload.success) {
      const issues = payload.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
      return toResponse(err(400, "invalid_payload", "Payload failed validation.", { issues }), requestId);
    }

    const headerKey = request.headers.get("idempotency-key");
    if (headerKey !== null && !IDEMPOTENCY.test(headerKey)) {
      return toResponse(err(400, "invalid_idempotency_key", "Idempotency-Key must be 1–200 characters of [A-Za-z0-9_.:@-]."), requestId);
    }
    const signature = request.headers.get("x-opsflow-signature") ?? "";

    const created = await createWorkflow(deps, {
      userId: auth.userId,
      actor: { type: "WEBHOOK", id: auth.keyId },
      source: "WEBHOOK",
      kind: "text",
      text: payload.data.text,
      // Both the header and external_id are covered by the signature (header explicitly, body implicitly).
      idempotencyKey: headerKey ?? payload.data.external_id,
      webhook: { credentialId: auth.credentialId, signatureHash: sha256(signature) },
    });
    if (created.conflict) {
      return toResponse(err(409, "idempotency_conflict", "This idempotency key was already used with a different payload."), requestId);
    }
    // Processing runs as a durable job. We give it a short head start so fast (mock) runs return a final status,
    // but the response never depends on the job finishing: n8n polls, and the worker/sweeper guarantee progress.
    if (!created.duplicate) await runJobInline(deps, { workflowId: created.id, type: "PROCESS_WORKFLOW" });

    const workflow = await deps.db.workflow.findFirstOrThrow({ where: { id: created.id, userId: auth.userId } });
    logger.info("webhook.workflow", { requestId, workflowId: workflow.id, duplicate: created.duplicate, reason: created.reason, status: workflow.status, durationMs: Date.now() - started });
    return toResponse(
      {
        status: created.duplicate ? 200 : 201,
        body: {
          id: workflow.id,
          status: workflow.status,
          needs_attention: workflow.needsAttention,
          duplicate: created.duplicate,
          failure_reason: workflow.failureReason,
          review_url: `${getEnv().APP_URL}/workflows/${workflow.id}`,
        },
      },
      requestId,
    );
  } catch (e) {
    if (e instanceof WorkflowError) return toResponse(err(400, "bad_request", e.userMessage), requestId);
    logger.error("webhook.unhandled", { requestId, error: e });
    return toResponse(err(500, "internal_error", "Something went wrong. Reference: " + requestId), requestId);
  }
}

/** GET /api/webhooks/workflow/:id — lets n8n poll for the outcome of human review. */
export async function handleWorkflowGet(request: Request, id: string, getDeps: () => WorkflowDeps = defaultDeps): Promise<Response> {
  const requestId = randomUUID();
  try {
    const deps = getDeps();
    const pre = await preflight(request, deps, false);
    if (!pre.ok) return toResponse(pre.response, requestId);
    const { auth } = pre;

    // Scoped by the credential's owner: another tenant's workflow is simply "not found".
    const w = await deps.db.workflow.findFirst({
      where: { id, userId: auth.userId },
      include: { extracted: true, reviews: true, actions: { where: { status: "SUCCEEDED" } } },
    });
    if (!w) return toResponse(err(404, "not_found", "Workflow not found."), requestId);

    const review = w.reviews[0];
    const approved = ["APPROVED", "EXECUTING", "COMPLETED"].includes(w.status) || (w.status === "FAILED" && review?.decision === "APPROVED");
    const confirmation = w.actions[0]?.output as { subject?: string; body?: string } | null | undefined;
    return toResponse(
      {
        status: 200,
        body: {
          id: w.id,
          status: w.status,
          needs_attention: w.needsAttention,
          decision: review ? review.decision.toLowerCase() : null,
          failure_reason: w.failureReason,
          updated_at: w.updatedAt.toISOString(),
          // Reviewed data is only released once a human has approved it — and it is the frozen approved snapshot.
          data: approved ? ((review?.approvedFields as ExtractedFields | null | undefined) ?? (w.extracted?.fields as ExtractedFields | undefined) ?? null) : null,
          confirmation: confirmation ? { subject: confirmation.subject, body: confirmation.body } : null,
        },
      },
      requestId,
    );
  } catch (e) {
    logger.error("webhook.unhandled", { requestId, error: e });
    return toResponse(err(500, "internal_error", "Something went wrong. Reference: " + requestId), requestId);
  }
}
