import { hmacSha256Hex, safeEqual } from "@/lib/crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** A timestamp this far in the FUTURE is rejected: honest clients are never ahead of us by more than clock skew. */
export const MAX_FUTURE_SKEW_SECONDS = 60;

/**
 * Canonical signed message. It is unambiguous because the timestamp is digits only and the idempotency key
 * cannot contain a newline (`[A-Za-z0-9_.:@-]`):
 *
 *   "v1" LF <unix-timestamp> LF <idempotency-key or empty> LF <raw body>
 *
 * The idempotency key is INSIDE the signature, so a captured request cannot be replayed under a different key.
 */
export function signedMessage(timestamp: string | number, idempotencyKey: string | null | undefined, rawBody: string): string {
  return ["v1", String(timestamp), idempotencyKey ?? "", rawBody].join("\n");
}

export function signPayload(secret: string, timestamp: string | number, rawBody: string, idempotencyKey?: string | null): string {
  return `sha256=${hmacSha256Hex(secret, signedMessage(timestamp, idempotencyKey, rawBody))}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "future" | "mismatch" };

export function verifySignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  idempotencyKey?: string | null;
  nowSeconds?: number;
}): SignatureCheck {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: "mismatch" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - Number(timestamp);
  if (age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  if (age < -MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: "future" };
  return safeEqual(signPayload(secret, timestamp, rawBody, input.idempotencyKey), signature.trim()) ? { ok: true } : { ok: false, reason: "mismatch" };
}
