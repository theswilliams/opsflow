/**
 * Starts the in-process job worker + sweeper when the Node server boots. Set OPSFLOW_WORKER=off to run
 * workers separately (`npm run worker`) — e.g. on serverless hosts where a long-lived loop is not possible;
 * user requests still give their own job a head start and the standalone worker/sweeper guarantees progress.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.OPSFLOW_WORKER === "off" || process.env.VITEST) return;
  const g = globalThis as { __opsflowWorkerStop?: () => void };
  if (g.__opsflowWorkerStop) return;
  const { defaultDeps } = await import("@/lib/workflow/core");
  const { startWorkerLoop } = await import("@/lib/jobs/worker");
  g.__opsflowWorkerStop = startWorkerLoop(defaultDeps());
}
