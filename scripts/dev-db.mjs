// Starts a local PostgreSQL server (real Postgres binaries via `embedded-postgres`).
// Keep this process running while you develop. Data lives in .data/pg.
import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const url = new URL(process.env.DATABASE_URL ?? "");
const dir = ".data/pg";
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
});

const fresh = !existsSync(`${dir}/PG_VERSION`);
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(url.pathname.slice(1));
console.log(`PostgreSQL ready on port ${url.port} (Ctrl+C to stop)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
