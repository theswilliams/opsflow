"use server";

import { redirect } from "next/navigation";
import { clientIp, endSession, requireUser } from "@/lib/auth/current-user";
import { authenticate } from "@/lib/auth/service";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { deleteAccount } from "@/lib/privacy";
import { loginAllowed, recordLoginFailure } from "@/lib/rate-limits";
import type { ActionState } from "./types";

/** Irreversible: requires the password AND the typed word DELETE. */
export async function deleteAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (String(formData.get("confirm") ?? "").trim() !== "DELETE") return { fieldErrors: { confirm: 'Type DELETE to confirm.' } };
  const ip = await clientIp();
  if (!loginAllowed(user.email, ip).allowed) return { error: "Too many attempts. Please wait a few minutes and try again." };
  const ok = await authenticate(getDb(), user.email, String(formData.get("password") ?? ""));
  if (!ok || ok.id !== user.id) {
    recordLoginFailure(user.email, ip);
    return { fieldErrors: { password: "Incorrect password." } };
  }
  try {
    await deleteAccount(getDb(), user.id);
  } catch (e) {
    logger.error("account.delete_failed", { error: e });
    return { error: "Could not delete the account. Nothing was changed. Please try again." };
  }
  await endSession();
  redirect("/login");
}
