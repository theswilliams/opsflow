import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Integration tests run against real PostgreSQL. Set TEST_DATABASE_URL to use an existing
 * server (e.g. a CI service container); otherwise a throw-away local cluster is started.
 */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

export default async function setup() {
  let stop: (() => Promise<void>) | undefined;
  let url = process.env.TEST_DATABASE_URL;

  if (!url) {
    const dir = mkdtempSync(path.join(tmpdir(), "opsflow-test-pg-"));
    const port = await freePort();
    const password = randomBytes(12).toString("hex");
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: "opsflow_test", password, port, persistent: true });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("opsflow_test");
    url = `postgresql://opsflow_test:${password}@localhost:${port}/opsflow_test`;
    stop = async () => {
      await pg.stop();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // Windows may still hold a lock briefly; the temp dir is disposable.
      }
    };
  }

  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });

  process.env.DATABASE_URL = url;
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_PROVIDER = "mock";
  process.env.OPSFLOW_PEER_SECRET = "test-peer-secret";
  process.env.APP_URL = "http://localhost:3000";

  return async () => {
    await stop?.();
  };
}
