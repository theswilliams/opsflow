// CI guard: fail if any migration drops a protected safeguard without recreating it.
//   node scripts/check-migrations.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { findDroppedSafeguards } from "./lib/migration-guard.mjs";

const dir = "prisma/migrations";
let failed = false;
for (const name of readdirSync(dir).sort()) {
  const file = path.join(dir, name, "migration.sql");
  if (!existsSync(file)) continue;
  const dropped = findDroppedSafeguards(readFileSync(file, "utf8"));
  if (dropped.length) {
    failed = true;
    console.error(`✗ ${name} drops protected safeguards: ${dropped.join(", ")}`);
  }
}
if (failed) {
  console.error("\nA generated migration removed a database safeguard. Re-add it to the migration (or, if the removal is intentional, update scripts/lib/migration-guard.mjs in the same change).");
  process.exit(1);
}
console.log("✓ no migration drops a protected safeguard");
