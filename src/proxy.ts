import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce-based Content-Security-Policy (replaces the old static `script-src 'unsafe-inline'`).
 * Next.js reads the nonce from the request's CSP header and applies it to its own inline scripts; scripts
 * without the nonce — e.g. injected by an XSS bug — are blocked by the browser. `'strict-dynamic'` lets the
 * nonced bootstrap load its chunks. Styles keep 'unsafe-inline' (style injection cannot execute script).
 */
export function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // CSP_MODE=report-only lets a deployment observe violations before enforcing; "off" exists for diagnosis only.
  const mode = process.env.CSP_MODE ?? "enforce";
  if (mode === "off") return NextResponse.next();
  const headerName = mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set(headerName, csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(headerName, csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
