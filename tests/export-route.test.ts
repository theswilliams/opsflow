/**
 * The data-export route: authentication, the cross-site guard, tenant scoping and its per-user limit.
 * The session lookup is stubbed (it needs Next's request context); everything else is the real route and database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppLimiters } from "@/lib/rate-limits";
import { DELIVERY_TEXT, makeUser, makeWorkflow } from "./helpers";

const session = vi.hoisted(() => ({ user: null as { id: string; email: string; name: string } | null }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => session.user }));

const { GET } = await import("@/app/api/account/export/route");
const get = (headers: Record<string, string> = {}) => GET(new Request("http://localhost/api/account/export", { headers }));

beforeEach(() => {
  session.user = null;
  resetAppLimiters();
});

describe("GET /api/account/export", () => {
  it("requires a signed-in user", async () => {
    expect((await get()).status).toBe(401);
  });

  it("refuses a cross-site request even with a valid session", async () => {
    const me = await makeUser("exp-x");
    session.user = { id: me.id, email: me.email, name: "Me" };
    const res = await get({ "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(me.email);
  });

  it("returns only the signed-in user's data, as a download that is never cached", async () => {
    const me = await makeUser("exp-me");
    const other = await makeUser("exp-other");
    await makeWorkflow(me.id, DELIVERY_TEXT);
    await makeWorkflow(other.id, DELIVERY_TEXT.replace("ABC Building Supplies", "Someone Else Ltd"));
    session.user = { id: me.id, email: me.email, name: "Me" };
    const res = await get({ "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    const text = await res.text();
    expect(text).toContain(me.email);
    expect(text).toContain("ABC Building Supplies");
    expect(text).not.toContain(other.email);
    expect(text).not.toContain("Someone Else Ltd");
  });

  it("is limited per user, and one user's exports do not use up another's allowance", async () => {
    const a = await makeUser("exp-a");
    const b = await makeUser("exp-b");
    session.user = { id: a.id, email: a.email, name: "A" };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await get()).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    session.user = { id: b.id, email: b.email, name: "B" };
    expect((await get()).status).toBe(200);
  });
});
