import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  // bcrypt only hashes the first 72 bytes, so longer passwords are rejected rather than silently truncated.
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .refine((p) => Buffer.byteLength(p) <= 72, "Use at most 72 bytes"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

// Verifying against a dummy hash for unknown users keeps login timing uniform.
const DUMMY_HASH = bcrypt.hashSync("opsflow-dummy-password", BCRYPT_COST);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

export class EmailTakenError extends Error {
  constructor() {
    super("Email already registered");
  }
}

export async function registerUser(db: Db, input: z.infer<typeof registerSchema>) {
  const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw new EmailTakenError();
  try {
    return await db.user.create({
      data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) },
      select: { id: true, email: true, name: true },
    });
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code: string }).code === "P2002") throw new EmailTakenError();
    throw err;
  }
}

/** Returns the user on success, null on any failure (unknown email and wrong password are indistinguishable). */
export async function authenticate(db: Db, email: string, password: string) {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? { id: user.id, email: user.email, name: user.name } : null;
}

/** Creates a DB-backed session and returns the opaque token (only its hash is stored). */
export async function createSession(db: Db, userId: string, now = new Date()) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt } });
  // Opportunistic cleanup keeps the table small without a scheduler.
  await db.session.deleteMany({ where: { userId, expiresAt: { lt: now } } });
  return { token, expiresAt };
}

export async function findSessionUser(db: Db, token: string, now = new Date()) {
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!session || session.expiresAt <= now) return null;
  return session.user;
}

export async function destroySession(db: Db, token: string) {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}
