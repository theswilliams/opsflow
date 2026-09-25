import { RateLimiter } from "./rate-limit";

/** App-level limiters (in-memory, single instance — see docs/SECURITY.md). */
export const appLimiters = {
  loginByEmail: new RateLimiter(8, 15 * 60_000),
  loginByIp: new RateLimiter(40, 15 * 60_000),
  registerByIp: new RateLimiter(10, 60 * 60_000),
  /** Protects AI spend: workflow creation per signed-in user. */
  createByUser: new RateLimiter(20, 60_000),
};
