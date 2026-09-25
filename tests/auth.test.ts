import { describe, expect, it } from "vitest";
import { authenticate, createSession, destroySession, EmailTakenError, findSessionUser, loginSchema, registerSchema, registerUser, SESSION_TTL_MS } from "@/lib/auth/service";
import { sha256 } from "@/lib/crypto";
import { getDb } from "@/lib/db";

const db = getDb();
const email = () => `user-${Math.random().toString(36).slice(2)}@example.test`;
const PASSWORD = "correct horse battery";

describe("registration and login", () => {
  it("registers with a hashed password and normalised email", async () => {
    const e = email();
    const parsed = registerSchema.parse({ name: "  Ada  ", email: e.toUpperCase(), password: PASSWORD });
    const user = await registerUser(db, parsed);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(e);
    expect(row.name).toBe("Ada");
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("rejects duplicate emails", async () => {
    const e = email();
    await registerUser(db, registerSchema.parse({ name: "A", email: e, password: PASSWORD }));
    await expect(registerUser(db, registerSchema.parse({ name: "B", email: e.toUpperCase(), password: PASSWORD }))).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("enforces the password policy", () => {
    expect(registerSchema.safeParse({ name: "A", email: email(), password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "A", email: email(), password: "x".repeat(73) }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "A", email: "not-an-email", password: PASSWORD }).success).toBe(false);
    expect(loginSchema.safeParse({ email: email(), password: "" }).success).toBe(false);
  });

  it("authenticates the right password and rejects wrong password / unknown user identically", async () => {
    const e = email();
    await registerUser(db, registerSchema.parse({ name: "A", email: e, password: PASSWORD }));
    expect(await authenticate(db, e, PASSWORD)).toMatchObject({ email: e });
    expect(await authenticate(db, e.toUpperCase(), PASSWORD)).not.toBeNull();
    expect(await authenticate(db, e, "wrong password!")).toBeNull();
    expect(await authenticate(db, "nobody@example.test", PASSWORD)).toBeNull();
  });
});

describe("sessions", () => {
  it("stores only a hash of the token and resolves the user from the raw token", async () => {
    const user = await registerUser(db, registerSchema.parse({ name: "A", email: email(), password: PASSWORD }));
    const { token } = await createSession(db, user.id);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await findSessionUser(db, token)).toMatchObject({ id: user.id });
    expect(await findSessionUser(db, "not-a-real-token")).toBeNull();
    expect(await findSessionUser(db, row.tokenHash)).toBeNull(); // the hash itself is not a credential
  });

  it("expires sessions and supports logout", async () => {
    const user = await registerUser(db, registerSchema.parse({ name: "A", email: email(), password: PASSWORD }));
    const { token } = await createSession(db, user.id);
    expect(await findSessionUser(db, token, new Date(Date.now() + SESSION_TTL_MS + 1000))).toBeNull();
    await destroySession(db, token);
    expect(await findSessionUser(db, token)).toBeNull();
  });
});
