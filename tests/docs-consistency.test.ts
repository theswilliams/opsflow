/**
 * Keeps the documentation honest: things a reader is told to copy or configure must match what the code does.
 * (A UI example that still described the pre-remediation webhook signature went unnoticed until a manual review.)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const tracked = (glob: string) => execSync(`git ls-files ${glob}`, { encoding: "utf8" }).split("\n").filter(Boolean);

describe("environment variables", () => {
  const example = new Set([...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  // Set by the platform, by server.mjs itself, or only by the test harness — not something an operator configures.
  const internal = new Set(["NODE_ENV", "NEXT_RUNTIME", "VITEST", "OPSFLOW_PEER_SECRET", "OPSFLOW_LOG_IN_TESTS"]);

  it("every variable in the validated env schema is documented in .env.example", () => {
    const schemaKeys = [...read("src/lib/env.ts").matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    expect(schemaKeys.length).toBeGreaterThan(15);
    expect(schemaKeys.filter((k) => !example.has(k))).toEqual([]);
  });

  it("every other process.env read in the app is documented or explicitly internal", () => {
    const files = [...tracked("src"), "server.mjs", "scripts/worker.ts"].filter((f) => /\.(ts|tsx|mjs)$/.test(f));
    const used = new Set<string>();
    for (const f of files) for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1] as string);
    expect([...used].filter((k) => !example.has(k) && !internal.has(k))).toEqual([]);
  });

  it(".env.example contains no real-looking secret", () => {
    const text = read(".env.example");
    expect(text).not.toMatch(/sk-ant-|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}/);
    expect(text).toMatch(/APP_ENCRYPTION_KEY=""/);
    expect(text).toMatch(/ANTHROPIC_API_KEY=""/);
  });
});

describe("webhook signing instructions", () => {
  const recipe = /printf 'v1\\+n%s\\+n\\+n%s' "\$TS" "\$BODY"/;

  it("the Integrations page example uses the current v1 signing scheme", () => {
    expect(read("src/app/(app)/settings/page.tsx")).toMatch(recipe);
    expect(read("src/app/(app)/settings/page.tsx")).not.toMatch(/\$TS\.\$BODY/);
  });

  it("docs/N8N.md documents the same recipe", () => {
    expect(read("docs/N8N.md")).toMatch(recipe);
  });
});

describe("repository hygiene", () => {
  it("no log, database, environment or local-tooling file is tracked", () => {
    const bad = tracked("").filter((f) => /\.log$|\.sqlite3?$|\.db$|\.dump$|^\.env(\.|$)(?!example)|^\.claude\/|^\.data\/|(^|\/)\.DS_Store$/.test(f));
    expect(bad).toEqual([]);
  });

  it("no tracked file contains a private-network address or a local machine path", () => {
    const files = tracked("").filter((f) => !/package-lock\.json$|\.png$|\.jpg$|^tests\//.test(f));
    const offenders = files.filter((f) => /\b192\.168\.\d+\.\d+\b|[A-Za-z]:\\Users\\|\/Users\/[a-z]+\//.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
