/**
 * F2 (client identity + login/registration isolation) and the lower-severity configuration findings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getAIProvider, ProviderConfigError } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { getEnv, parseEnv, resetEnvCacheForTests } from "@/lib/env";
import { buildTrustList, normalizeIp, resolveClientIp } from "@/lib/net/client-ip";
import { proxy } from "@/proxy";
import { appLimiters, loginAllowed, recordLoginFailure, recordLoginSuccess, registrationAllowed, resetAppLimiters } from "@/lib/rate-limits";
import { approveCurrent, DELIVERY_TEXT, makeUser, makeWorkflow, testDeps } from "./helpers";

const h = (init: Record<string, string>) => new Headers(init);
const BASE = { DATABASE_URL: "x", APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") };

describe("client address resolution (trust model)", () => {
  it("is unknown (null) when nothing trustworthy is available — never a shared placeholder", () => {
    expect(resolveClientIp(h({}))).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": "1.2.3.4" }))).toBeNull(); // forwarded headers alone are not trusted
    expect(resolveClientIp(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }), { trustProxyHops: 0 })).toBeNull();
  });

  it("uses the real socket peer, ignoring any forwarding header, when no proxy is trusted", () => {
    expect(resolveClientIp(h({ "x-opsflow-peer": "198.51.100.5", "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBe("198.51.100.5");
    expect(resolveClientIp(h({ "x-opsflow-peer": "::ffff:198.51.100.5" }))).toBe("198.51.100.5");
    expect(resolveClientIp(h({ "x-opsflow-peer": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("an untrusted peer cannot borrow a trusted proxy's authority by sending forwarding headers", () => {
    const cfg = { trustedProxies: "192.0.2.10" };
    expect(resolveClientIp(h({ "x-opsflow-peer": "198.51.100.5", "x-forwarded-for": "203.0.113.9" }), cfg)).toBe("198.51.100.5");
  });

  it("behind a trusted proxy the client is the RIGHTMOST untrusted hop, so a forged leftmost entry is useless", () => {
    const cfg = { trustedProxies: "192.0.2.10, 192.0.2.11" };
    const forged = h({ "x-opsflow-peer": "192.0.2.10", "x-forwarded-for": "6.6.6.6, 203.0.113.9, 192.0.2.11" });
    expect(resolveClientIp(forged, cfg)).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-opsflow-peer": "192.0.2.10", "x-forwarded-for": "192.0.2.11" }), cfg)).toBe("192.0.2.10"); // only proxies → the proxy
    expect(resolveClientIp(h({ "x-opsflow-peer": "192.0.2.10" }), cfg)).toBe("192.0.2.10");
  });

  it("supports CIDR ranges and IPv6 in the trust list", () => {
    const cfg = { trustedProxies: "10.0.0.0/8, 2001:db8::/32" };
    expect(resolveClientIp(h({ "x-opsflow-peer": "10.4.5.6", "x-forwarded-for": "203.0.113.1" }), cfg)).toBe("203.0.113.1");
    expect(resolveClientIp(h({ "x-opsflow-peer": "2001:db8::5", "x-forwarded-for": "203.0.113.2" }), cfg)).toBe("203.0.113.2");
    expect(resolveClientIp(h({ "x-opsflow-peer": "11.0.0.1", "x-forwarded-for": "203.0.113.3" }), cfg)).toBe("11.0.0.1");
    const list = buildTrustList("garbage, 10.0.0.1/33x, 192.168.0.0/16");
    expect(list.check("192.168.4.4")).toBe(true);
    expect(list.check("10.0.0.1")).toBe(false);
  });

  it("platform mode: with N trusted hops the client is the Nth entry from the right; leftmost forgery is ignored", () => {
    const xff = h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    expect(resolveClientIp(xff, { trustProxyHops: 1 })).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }), { trustProxyHops: 2 })).toBe("203.0.113.9");
    expect(resolveClientIp(xff, { trustProxyHops: 3 })).toBeNull(); // fewer hops than promised: refuse to guess
    expect(resolveClientIp(h({ "x-forwarded-for": "not-an-ip, 203.0.113.9" }), { trustProxyHops: 1 })).toBe("203.0.113.9");
  });

  it("normalises noise", () => {
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("203.0.113.9:5555")).toBe("203.0.113.9");
    expect(normalizeIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeIp("javascript:alert(1)")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe("F2 · login and registration isolation", () => {
  afterEach(() => resetAppLimiters());

  it("5. abuse against account A from one address does not lock account B, nor account A's owner elsewhere", () => {
    for (let i = 0; i < 8; i++) recordLoginFailure("victim@example.test", "198.51.100.66");
    expect(loginAllowed("victim@example.test", "198.51.100.66").allowed).toBe(false); // the attacker is throttled
    expect(loginAllowed("victim@example.test", "203.0.113.7").allowed).toBe(true); // the real owner is not
    expect(loginAllowed("other@example.test", "198.51.100.66").allowed).toBe(true); // other accounts unaffected (same attacker, below per-IP cap)
    expect(loginAllowed("other@example.test", "203.0.113.7").allowed).toBe(true);
  });

  it("one address cannot exhaust another address's login budget, however many accounts it sprays", () => {
    for (let i = 0; i < 40; i++) recordLoginFailure(`user${i}@example.test`, "198.51.100.66");
    expect(loginAllowed("anyone@example.test", "198.51.100.66").allowed).toBe(false); // sprayer blocked entirely
    expect(loginAllowed("anyone@example.test", "203.0.113.7").allowed).toBe(true); // everyone else fine
  });

  it("a successful login clears that (account, address) failure history", () => {
    for (let i = 0; i < 7; i++) recordLoginFailure("me@example.test", "203.0.113.7");
    recordLoginSuccess("me@example.test", "203.0.113.7");
    for (let i = 0; i < 7; i++) recordLoginFailure("me@example.test", "203.0.113.7");
    expect(loginAllowed("me@example.test", "203.0.113.7").allowed).toBe(true);
  });

  it("with an unknown client address nothing is throttled by a shared bucket (and nothing can lock a user out)", () => {
    for (let i = 0; i < 500; i++) recordLoginFailure("victim@example.test", null);
    expect(loginAllowed("victim@example.test", null).allowed).toBe(true);
    for (let i = 0; i < 100; i++) expect(registrationAllowed(null)).toBe(true);
  });

  it("6. one client cannot exhaust registration for everyone", () => {
    const results = Array.from({ length: 12 }, () => registrationAllowed("198.51.100.66"));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(registrationAllowed("203.0.113.7")).toBe(true);
    expect(appLimiters.registerByIp.peek("203.0.113.7").remaining).toBe(9);
  });
});

describe("configuration validation (lower-severity findings)", () => {
  afterEach(() => resetEnvCacheForTests());

  it("BUSINESS_TIMEZONE is validated at startup with a clear message", () => {
    const bad = parseEnv({ ...BASE, BUSINESS_TIMEZONE: "Toronto" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/BUSINESS_TIMEZONE must be a valid IANA time zone/);
    expect(parseEnv({ ...BASE, BUSINESS_TIMEZONE: "America/Toronto" }).success).toBe(true);
    expect(parseEnv({ ...BASE, BUSINESS_TIMEZONE: "Europe/Paris" }).data?.BUSINESS_TIMEZONE).toBe("Europe/Paris");
    expect(parseEnv({ ...BASE, BUSINESS_TIMEZONE: "" }).data?.BUSINESS_TIMEZONE).toBe("America/Toronto"); // empty = default
    expect(parseEnv({ ...BASE, BUSINESS_TIMEZONE: "Not/AZone" }).success).toBe(false);
  });

  it("getEnv() throws a descriptive configuration error instead of failing later during a date calculation", () => {
    const old = process.env.BUSINESS_TIMEZONE;
    process.env.BUSINESS_TIMEZONE = "Middle/Earth";
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/Invalid environment configuration.*BUSINESS_TIMEZONE/);
    if (old === undefined) delete process.env.BUSINESS_TIMEZONE;
    else process.env.BUSINESS_TIMEZONE = old;
  });

  it("the encryption key and other required settings are still enforced", () => {
    expect(parseEnv({ DATABASE_URL: "x", APP_ENCRYPTION_KEY: "short" }).success).toBe(false);
    expect(parseEnv({ APP_ENCRYPTION_KEY: BASE.APP_ENCRYPTION_KEY }).success).toBe(false);
  });

  it("AI provider misconfiguration is explicit and typed: no undefined-cast provider anywhere", async () => {
    const old = { p: process.env.AI_PROVIDER, k: process.env.ANTHROPIC_API_KEY };
    process.env.AI_PROVIDER = "claude";
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCacheForTests();
    expect(() => getAIProvider()).toThrow(ProviderConfigError);
    expect(() => getAIProvider()).toThrow(/ANTHROPIC_API_KEY/);
    process.env.AI_PROVIDER = old.p;
    if (old.k) process.env.ANTHROPIC_API_KEY = old.k;
    resetEnvCacheForTests();
    expect(getAIProvider().name).toBe("mock");
  });

  it("a misconfigured provider fails the workflow clearly (terminal, no retry storm) — while review/approval paths keep working", async () => {
    const user = await makeUser("cfg");
    const good = await makeWorkflow(user.id);
    const broken = testDeps({ ai: () => { throw new ProviderConfigError("AI_PROVIDER=claude requires ANTHROPIC_API_KEY"); } });
    // approval never touches the AI provider:
    expect((await approveCurrent(broken, good.id, user.id)).status).toBe("COMPLETED");
    // processing does, and reports it properly:
    const failed = await makeWorkflow(user.id, `${DELIVERY_TEXT}\nRef misconfigured`, broken);
    expect(failed.workflow.status).toBe("FAILED");
    expect(failed.workflow.failureReason).toMatch(/not configured correctly/);
    expect(failed.workflow.failureReason).not.toMatch(/ANTHROPIC_API_KEY/); // internals stay out of the UI
    expect((await getDb().job.findFirstOrThrow({ where: { workflowId: failed.id } })).attempts).toBe(1);
  });
});

describe("Content-Security-Policy (nonce-based)", () => {
  const csp = (path = "/dashboard") => {
    const res = proxy(new NextRequest(`http://localhost:3000${path}`));
    return { header: res.headers.get("content-security-policy") ?? "", res };
  };

  it("has no 'unsafe-inline' or wildcard in script-src, uses a fresh per-request nonce, and forbids framing/objects", () => {
    const a = csp().header;
    const b = csp().header;
    const scriptSrc = /script-src ([^;]+)/.exec(a)?.[1] ?? "";
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toMatch(/\*|https?:/);
    expect(a).toContain("object-src 'none'");
    expect(a).toContain("frame-ancestors 'none'");
    expect(a).toContain("base-uri 'self'");
    expect(a).toContain("form-action 'self'");
    expect(/nonce-([^']+)/.exec(a)![1]).not.toBe(/nonce-([^']+)/.exec(b)![1]); // fresh nonce each request
  });

  it("forwards the same policy to the rendering layer via the request headers", () => {
    const { res, header } = csp();
    expect(res.headers.get("x-middleware-request-content-security-policy") ?? header).toContain("nonce-");
  });
});
