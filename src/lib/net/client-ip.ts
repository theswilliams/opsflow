import { BlockList, isIP } from "node:net";

/**
 * Client address resolution.
 *
 * Trust model
 * -----------
 * 1. **Custom server (`server.mjs`, used by `npm start`)** stamps every request with the real TCP peer in
 *    `x-opsflow-peer` and strips any client-supplied copy. That is the only source of truth for "who is
 *    connected". If the peer is NOT in TRUSTED_PROXIES, forwarding headers are ignored completely.
 *    If the peer IS a trusted proxy, `X-Forwarded-For` is walked from the RIGHT (the hops closest to us,
 *    appended by infrastructure we control) and the first address that is not itself a trusted proxy wins.
 *    The leftmost entry is client-controlled and is never used on its own.
 * 2. **Platform mode (no peer header, e.g. serverless)**: if TRUST_PROXY_HOPS = n > 0 the client is the
 *    n-th entry from the right of `X-Forwarded-For` (each trusted hop appends one). With 0 hops no
 *    forwarding header is trusted.
 * 3. Otherwise the address is unknown (`null`). Callers must NOT collapse unknown clients into one shared
 *    bucket: unknown means "do not apply per-IP limits", never "everyone is the same client".
 */
export interface ClientIpConfig {
  trustedProxies?: string;
  trustProxyHops?: number;
}

export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

export function buildTrustList(spec: string | undefined): BlockList {
  const list = new BlockList();
  for (const entry of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = entry.split("/");
    const ip = normalizeIp(addr);
    if (!ip) continue;
    const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) {
      list.addAddress(ip, family);
    } else {
      // A malformed prefix is skipped entirely: an entry we cannot parse must never widen trust.
      const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
      if (bits >= 0 && bits <= (family === "ipv6" ? 128 : 32)) list.addSubnet(ip, bits, family);
    }
  }
  return list;
}

const isTrusted = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

export function resolveClientIp(headers: Headers, config: ClientIpConfig = {}): string | null {
  const hops = config.trustProxyHops ?? 0;
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter((s): s is string => Boolean(s));

  const peer = normalizeIp(headers.get("x-opsflow-peer"));
  if (peer) {
    const trusted = buildTrustList(config.trustedProxies);
    if (!isTrusted(trusted, peer)) return peer;
    for (let i = forwarded.length - 1; i >= 0; i--) {
      const hop = forwarded[i]!;
      if (!isTrusted(trusted, hop)) return hop;
    }
    return peer;
  }

  if (hops > 0 && forwarded.length >= hops) return forwarded[forwarded.length - hops] ?? null;
  return null;
}

/** Reads the trust configuration from the environment (kept out of resolveClientIp so it stays pure). */
export function clientIpFromRequest(headers: Headers): string | null {
  return resolveClientIp(headers, {
    trustedProxies: process.env.TRUSTED_PROXIES,
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
  });
}
