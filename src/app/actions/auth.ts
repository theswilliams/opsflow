"use server";

import { redirect } from "next/navigation";
import { clientIp, endSession, startSession } from "@/lib/auth/current-user";
import { authenticate, EmailTakenError, loginSchema, registerSchema, registerUser } from "@/lib/auth/service";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { appLimiters } from "@/lib/rate-limits";
import type { ActionState } from "./types";

const TOO_MANY = "Too many attempts. Please wait a few minutes and try again.";

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };

  const ip = await clientIp();
  if (!appLimiters.loginByIp.check(ip).allowed || !appLimiters.loginByEmail.check(parsed.data.email).allowed) return { error: TOO_MANY };

  const user = await authenticate(getDb(), parsed.data.email, parsed.data.password);
  if (!user) {
    logger.warn("auth.login_failed");
    return { error: "Incorrect email or password." };
  }
  appLimiters.loginByEmail.reset(parsed.data.email);
  await startSession(user.id);
  redirect("/dashboard");
}

export async function registerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = registerSchema.safeParse({ name: formData.get("name"), email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return { fieldErrors };
  }
  if (!appLimiters.registerByIp.check(await clientIp()).allowed) return { error: TOO_MANY };

  try {
    const user = await registerUser(getDb(), parsed.data);
    await startSession(user.id);
  } catch (e) {
    if (e instanceof EmailTakenError) return { fieldErrors: { email: "An account with this email already exists." } };
    logger.error("auth.register_failed", { error: e });
    return { error: "Could not create the account. Please try again." };
  }
  redirect("/dashboard");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}
