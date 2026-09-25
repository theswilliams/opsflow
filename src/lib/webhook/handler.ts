import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_INPUT_CHARS } from "@/lib/ai/extract";
import type { ExtractedFields } from "@/lib/ai/schema";
import { sha256 } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { RateLimiter } from "@/lib/rate-limit";
import { AUDIT, recordAudit } from "@/lib/workflow/audit";
import { WorkflowError } from "@/lib/workflow/errors";
import { createWorkflow, defaultDeps, processWorkflow, type WorkflowDeps } from "@/lib/workflow/service";
import { findActiveCredential } from "./credentials";
import { verifySignature } from "./signature";

export const MAX_BODY_BYTES = 64 * 1024;

/** In-memory limiters (single instance). See docs/SECURITY.md for the multi-instance note. */
export const limiters = {
  ip: new RateLimiter(120, 60_000),
  key: new RateLimiter(60, 60_000),
  badSignature: new RateLimiter(10, 60_000),
  auditThrottle: new RateLimiter(3, 3_600_000),
};

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

/**
 * Forwarded-for headers are client-controlled unless a trusted reverse proxy sets them.
 * They are only honoured when TRUST_PROXY=true; otherwise every caller shares one "direct" bucket.
 */
export function clientIpFrom(request: Request): string {
  if (process.env.TRUST_PROXY !== "true") return "direct";
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
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

type AuthResult = { ok: true; userId: string; keyId: string; credentialId: string } | { ok: false; response: Handled };

const UNAUTHORIZED = () => err(401, "unauthorized", "Missing or invalid credentials.");

async function authenticate(request: Request, rawBody: string, deps: WorkflowDeps): Promise<AuthResult> {
  const keyId = request.headers.get("x-opsflow-key-id");
  const credential = keyId && keyId.length < 100 ? await findActiveCredential(deps.db, keyId) : null;
  // Unknown key, bad signature, stale timestamp: the same 401, so nothing is revealed to a prober.
  if (!keyId) return { ok: false, response: UNAUTHORIZED() };
  // Keyed by (key, IP): a stranger who knows a public key id cannot lock the legitimate client out.
  const failKey = `${keyId}|${clientIpFrom(request)}`;
  const fail = limiters.badSignature.check(failKey);
  if (!fail.allowed) {
    return { ok: false, response: err(429, "rate_limited", "Too many failed attempts.", {}, { "retry-after": String(fail.retryAfterSeconds) }) };
  }
  if (!credential) return { ok: false, response: UNAUTHORIZED() };
  const check = verifySignature({
    secret: credential.secret,
    timestamp: request.headers.get("x-opsflow-timestamp"),
    signature: request.headers.get("x-opsflow-signature"),
    rawBody,
  });
  if (!check.ok) {
    logger.warn("webhook.auth_failed", { keyId, reason: check.reason });
    if (limiters.auditThrottle.check(keyId).allowed) {
      await recordAudit(deps.db, {
        userId: credential.userId,
        actor: { type: "WEBHOOK", id: keyId },
        eventType: AUDIT.WEBHOOK_REJECTED,
        message: `Webhook request rejected (${check.reason} signature)`,
        metadata: { reason: check.reason },
      });
    }
    return { ok: false, response: UNAUTHORIZED() };
  }
  // A valid signature means this attempt was legitimate; do not count it against the key.
  limiters.badSignature.reset(failKey);
  return { ok: true, userId: credential.userId, keyId, credentialId: credential.id };
}

type Preflight = { ok: true; auth: Extract<AuthResult, { ok: true }>; rawBody: string } | { ok: false; response: Handled };

async function preflight(request: Request, deps: WorkflowDeps, needsBody: boolean): Promise<Preflight> {
  const fail = (response: Handled): Preflight => ({ ok: false, response });
  const ip = limiters.ip.check(clientIpFrom(request));
  if (!ip.allowed) return fail(err(429, "rate_limited", "Too many requests.", {}, { "retry-after": String(ip.retryAfterSeconds) }));
  if (needsBody && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return fail(err(415, "unsupported_media_type", "Content-Type must be application/json."));
  }
  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return fail(err(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes.`));
  const auth = await authenticate(request, body.text, deps);
  if (!auth.ok) return fail(auth.response);
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
    // Without an explicit key, the signature itself is the key: replaying a captured request within the
    // timestamp window returns the original workflow instead of creating a duplicate.
    const idempotencyKey = headerKey ?? payload.data.external_id ?? `sig:${sha256(request.headers.get("x-opsflow-signature") ?? "").slice(0, 40)}`;

    const created = await createWorkflow(deps, {
      userId: auth.userId,
      actor: { type: "WEBHOOK", id: auth.keyId },
      source: "WEBHOOK",
      kind: "text",
      text: payload.data.text,
      idempotencyKey,
    });
    if (created.conflict) {
      return toResponse(err(409, "idempotency_conflict", "This idempotency key was already used with a different payload."), requestId);
    }

    const workflow = created.duplicate
      ? await deps.db.workflow.findFirstOrThrow({ where: { id: created.id, userId: auth.userId } })
      : await processWorkflow(deps, { workflowId: created.id, userId: auth.userId, actor: { type: "WEBHOOK", id: auth.keyId } });

    logger.info("webhook.workflow", { requestId, workflowId: workflow.id, duplicate: created.duplicate, status: workflow.status, durationMs: Date.now() - started });
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
          // Reviewed data is only released once a human has approved it.
          data: approved ? (w.extracted?.fields as ExtractedFields | undefined) ?? null : null,
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
