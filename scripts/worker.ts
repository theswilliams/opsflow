// Standalone job worker + sweeper:  npm run worker
// Run this (and set OPSFLOW_WORKER=off on the web process) to keep AI and PDF work off the web server.
import "dotenv/config";
import { startWorkerLoop } from "../src/lib/jobs/worker";
import { defaultDeps } from "../src/lib/workflow/core";

const deps = defaultDeps();
const stop = startWorkerLoop(deps);
console.log(`OpsFlow worker ${deps.workerId} started (Ctrl+C to stop)`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
}
setInterval(() => {}, 1 << 30);
