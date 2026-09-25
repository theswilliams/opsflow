import "dotenv/config";
import { getDb } from "../src/lib/db";
import { seedDemo } from "../src/lib/demo/seed";

async function main() {
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) {
    throw new Error("DEMO_USER_PASSWORD is not set. Run `npm run setup` (generates .env) or set it yourself.");
  }
  const db = getDb();
  const result = await seedDemo(db, { password, withCredential: true });
  console.log(`Seeded demo data for ${result.email} (${Object.keys(result.workflowIds).length} workflows).`);
  if (result.credential) {
    console.log("\nDemo webhook credential (shown once — store it in n8n):");
    console.log(`  X-OpsFlow-Key-Id: ${result.credential.keyId}`);
    console.log(`  Signing secret:   ${result.credential.secret}`);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
