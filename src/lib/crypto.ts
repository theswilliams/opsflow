import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
export const hmacSha256Hex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const key = () => Buffer.from(getEnv().APP_ENCRYPTION_KEY, "base64");

/** AES-256-GCM. Output: base64url(iv).base64url(tag).base64url(ciphertext) */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !enc) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
