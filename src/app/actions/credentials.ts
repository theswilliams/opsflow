"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { appLimiters } from "@/lib/rate-limits";
import { WorkflowError } from "@/lib/workflow/errors";
import { createCredential, revokeCredential } from "@/lib/webhook/credentials";
import type { ActionState } from "./types";

export async function createCredentialAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const label = String(formData.get("label") ?? "").trim();
  if (label.length > 60) return { fieldErrors: { label: "Use at most 60 characters." } };
  if (!appLimiters.credentialCreateByUser.check(user.id).allowed) return { error: "You are creating credentials too quickly. Try again later." };
  try {
    const cred = await createCredential(getDb(), user.id, label || "n8n", getEnv().MAX_CREDENTIALS_PER_USER);
    revalidatePath("/settings");
    return { ok: "Credential created. Copy the secret now — it is shown only once.", secret: cred };
  } catch (e) {
    if (e instanceof WorkflowError) return { error: e.userMessage };
    logger.error("credential.create_failed", { error: e });
    return { error: "Could not create the credential." };
  }
}

export async function revokeCredentialAction(credentialId: string): Promise<void> {
  const user = await requireUser();
  await revokeCredential(getDb(), user.id, credentialId);
  revalidatePath("/settings");
}
