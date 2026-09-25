"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createCredential, revokeCredential } from "@/lib/webhook/credentials";
import type { ActionState } from "./types";

export async function createCredentialAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const label = String(formData.get("label") ?? "").trim();
  if (label.length > 60) return { fieldErrors: { label: "Use at most 60 characters." } };
  try {
    const cred = await createCredential(getDb(), user.id, label || "n8n");
    revalidatePath("/settings");
    return { ok: "Credential created. Copy the secret now — it is shown only once.", secret: cred };
  } catch (e) {
    logger.error("credential.create_failed", { error: e });
    return { error: "Could not create the credential." };
  }
}

export async function revokeCredentialAction(credentialId: string): Promise<void> {
  const user = await requireUser();
  await revokeCredential(getDb(), user.id, credentialId);
  revalidatePath("/settings");
}
