import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import { decryptSecret, encryptSecret, randomToken } from "@/lib/crypto";
import { AUDIT, recordAudit } from "@/lib/workflow/audit";

/**
 * Per-user webhook signing credentials.
 * The public `keyId` identifies the tenant; the secret proves possession and is
 * encrypted at rest. The secret is shown exactly once, at creation.
 */
export async function createCredential(db: Db, userId: string, label: string) {
  const keyId = `ofk_${randomBytes(12).toString("hex")}`;
  const secret = `ofs_${randomToken(32)}`;
  const cleanLabel = label.trim().slice(0, 60) || "n8n";
  await db.$transaction(async (tx) => {
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

export async function findActiveCredential(db: Db, keyId: string) {
  const c = await db.apiCredential.findFirst({ where: { keyId, revokedAt: null } });
  if (!c) return null;
  return { id: c.id, userId: c.userId, keyId: c.keyId, secret: decryptSecret(c.encryptedSecret) };
}
