import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { createSession, destroySession, findSessionUser, SESSION_TTL_MS } from "./service";

const COOKIE = "opsflow_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function startSession(userId: string) {
  const { token, expiresAt } = await createSession(getDb(), userId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await destroySession(getDb(), token);
  jar.delete(COOKIE);
}

/** The signed-in user, or null. Memoised per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(getDb(), token);
});

/** Use at the top of every protected page and server action. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** See clientIpFrom in the webhook handler: forwarded headers are only trusted when TRUST_PROXY=true. */
export async function clientIp(): Promise<string> {
  if (process.env.TRUST_PROXY !== "true") return "direct";
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
