import { setTimeout as delay } from "node:timers/promises";
import { engineFromEnv } from "@/imaging/engines";
import { getContext } from "@/server/context";
import { runJanitor } from "./janitor";
import { runJob } from "./runner";

/**
 * Queue consumer. Runs as its own process next to the Next.js server so native work
 * lives outside HTTP request lifetimes. Concurrency is one job at a time.
 */

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), role: "worker", event, ...fields }));
}

async function main(): Promise<void> {
  const { store, batches, config } = getContext();
  const engine = engineFromEnv();
  const shutdown = new AbortController();

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      log("shutdown_requested", { signal: sig });
      shutdown.abort();
    });
  }

  for (const job of store.reconcileInterrupted()) log("job_interrupted", { jobId: job.id });
  log("started", { engine: engine.name, pid: process.pid, dataDir: config.dataDir });

  store.heartbeat(process.pid);
  const heartbeat = setInterval(() => store.heartbeat(process.pid), 5000);

  let nextJanitor = 0;
  while (!shutdown.signal.aborted) {
    if (Date.now() >= nextJanitor) {
      try {
        const report = await runJanitor(store, config, batches);
        if (report.expired.length || report.purged.length || report.orphans.length || report.expiredBatches.length) {
          log("janitor", { ...report });
        }
      } catch (error) {
        log("janitor_failed", { error: String(error) });
      }
      nextJanitor = Date.now() + config.janitorIntervalMs;
    }

    const job = store.claimNext();
    if (!job) {
      await delay(config.workerPollMs, undefined, { signal: shutdown.signal }).catch(() => {});
      continue;
    }

    log("job_claimed", { jobId: job.id, state: job.state });
    try {
      await runJob({ store, config, engine, log, shutdown: shutdown.signal }, job);
    } catch (error) {
      // Unexpected bug or IO failure. Startup reconciliation would otherwise catch this,
      // but failing now gives the user an answer without a restart.
      log("job_crashed", { jobId: job.id, error: String(error) });
      const current = store.get(job.id);
      if (current && (current.state === "merging" || current.state === "rendering_preview")) {
        store.transition(job.id, current.state, "failed", {
          errorCode: "internal_error",
          errorMessage: "Something went wrong while processing. You can retry this job.",
          retryable: true,
        });
      }
    }
  }

  clearInterval(heartbeat);
  log("stopped");
}

main().catch((error) => {
  log("fatal", { error: String(error) });
  process.exit(1);
});
