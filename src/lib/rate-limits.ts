import { RateLimiter } from "./rate-limit";

/**
 * App-level limiters (in-memory, single instance — see docs/SECURITY.md).
 *
 * Isolation rules:
 *  - Login limits count FAILURES only, keyed by (email, client address) and by client address. An attacker can
 *    therefore only lock THEMSELVES out; the account owner (a different address) and every other account are
 *    unaffected. There is deliberately no per-email global lockout, which would let anyone lock out a chosen user.
 *  - When the client address is unknown (see net/client-ip.ts) address-keyed limits are skipped rather than
 *    collapsed into one shared bucket.
 */
export const appLimiters = {
  loginFailuresByEmailAndIp: new RateLimiter(8, 15 * 60_000),
  loginFailuresByIp: new RateLimiter(40, 15 * 60_000),
  registerByIp: new RateLimiter(10, 60 * 60_000),
  /** Protects AI spend: workflow creation per signed-in user. */
  createByUser: new RateLimiter(20, 60_000),
  credentialCreateByUser: new RateLimiter(5, 60 * 60_000),
  /** The export walks every row a user owns; a signed-in client should not be able to repeat it in a loop. */
  exportByUser: new RateLimiter(5, 60_000),
};

export function resetAppLimiters() {
  Object.values(appLimiters).forEach((l) => l.reset());
}

export function loginAllowed(email: string, ip: string | null): { allowed: boolean } {
  if (!ip) return { allowed: true };
  const a = appLimiters.loginFailuresByEmailAndIp.peek(`${email}|${ip}`);
  const b = appLimiters.loginFailuresByIp.peek(ip);
  return { allowed: a.allowed && b.allowed };
}

export function recordLoginFailure(email: string, ip: string | null) {
  if (!ip) return;
  appLimiters.loginFailuresByEmailAndIp.hit(`${email}|${ip}`);
  appLimiters.loginFailuresByIp.hit(ip);
}

export function recordLoginSuccess(email: string, ip: string | null) {
  if (ip) appLimiters.loginFailuresByEmailAndIp.reset(`${email}|${ip}`);
}

export function registrationAllowed(ip: string | null): boolean {
  return ip ? appLimiters.registerByIp.check(ip).allowed : true;
}
