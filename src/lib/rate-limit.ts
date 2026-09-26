/**
 * Sliding-window rate limiter.
 *
 * In-memory: correct for a single Node process (local, single-instance deploys). State is NOT shared between
 * processes, so with N instances each key can be used N times over. A multi-instance deployment must back
 * this interface with a shared store (Redis / Postgres) — see docs/SECURITY.md. Durable, tenant-level
 * ceilings that matter for cost (AI usage budgets, credential counts) do NOT use this class: they live in the database.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limitOrFn: number | (() => number),
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private get limit() {
    return typeof this.limitOrFn === "function" ? this.limitOrFn() : this.limitOrFn;
  }

  /** Read-only: is `key` currently over its limit? Does not consume capacity. */
  peek(key: string): RateLimitResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000)) };
    }
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  /** Records one event without deciding anything (used to count failures only). */
  hit(key: string): void {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now - this.windowMs);
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(cutoff);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  reset(key?: string) {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }

  private sweep(cutoff: number) {
    for (const [k, v] of this.hits) if (v.every((t) => t <= cutoff)) this.hits.delete(k);
  }
}
