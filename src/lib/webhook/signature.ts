import { hmacSha256Hex, safeEqual } from "@/lib/crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The signed message binds the timestamp to the exact raw body: `${timestamp}.${body}`. */
export function signPayload(secret: string, timestamp: string | number, rawBody: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" };

export function verifySignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
}): SignatureCheck {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: "mismatch" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  return safeEqual(signPayload(secret, timestamp, rawBody), signature.trim()) ? { ok: true } : { ok: false, reason: "mismatch" };
}
