import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import { decryptSecret, encryptSecret, randomToken } from "@/lib/crypto";
import { AUDIT, recordAudit } from "@/lib/workflow/audit";
import { WorkflowError } from "@/lib/workflow/errors";

/**
 * Per-user webhook signing credentials.
 * The public `keyId` identifies the tenant; the secret proves possession and is
 * encrypted at rest. The secret is shown exactly once, at creation.
 *
 * A tenant may hold at most `maxActive` credentials, so per-credential rate limits cannot be multiplied
 * by minting more of them.
 */
export async function createCredential(db: Db, userId: string, label: string, maxActive = 5) {
  const keyId = `ofk_${randomBytes(12).toString("hex")}`;
  const secret = `ofs_${randomToken(32)}`;
  const cleanLabel = label.trim().slice(0, 60) || "n8n";
  await db.$transaction(async (tx) => {
    // Serialise per user so two simultaneous requests cannot both slip under the cap.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cred:${userId}`}, 0))`;
    const active = await tx.apiCredential.count({ where: { userId, revokedAt: null } });
    if (active >= maxActive) {
      throw new WorkflowError("LIMIT_EXCEEDED", `You can have at most ${maxActive} active webhook credentials. Revoke one first.`);
    }
    await tx.apiCredential.create({ data: { userId, keyId, encryptedSecret: encryptSecret(secret), label: cleanLabel } });
    await recordAudit(tx, { userId, actor: { type: "USER", id: userId }, eventType: AUDIT.CREDENTIAL_CREATED, message: `Webhook credential "${cleanLabel}" created`, metadata: { keyId } });
  });
  return { keyId, secret };
}

export async function revokeCredential(db: Db, userId: string, credentialId: string) {
  const { count } = await db.apiCredential.updateMany({ where: { id: credentialId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count) {
    await recordAudit(db, { userId, actor: { type: "USER", id: userId }, eventType: AUDIT.CREDENTIAL_REVOKED, message: "Webhook credential revoked", metadata: { credentialId } });
  }
  return count === 1;
}

export async function listCredentials(db: Db, userId: string) {
  return db.apiCredential.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, keyId: true, label: true, createdAt: true, revokedAt: true, lastUsedAt: true },
  });
}

/** Lookup by public key id. Returns the encrypted row; decryption happens in the caller so both branches cost the same. */
export async function findActiveCredentialRow(db: Db, keyId: string) {
  return db.apiCredential.findFirst({ where: { keyId, revokedAt: null } });
}

export const decryptCredentialSecret = decryptSecret;
