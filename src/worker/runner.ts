import fsp from "node:fs/promises";
import { EngineError, type ImagingEngine } from "@/imaging/engine";
import type { AppConfig } from "@/server/config";
import type { JobState } from "@/server/jobs/states";
import type { Job, JobStore } from "@/server/jobs/store";
import { fileSize, removeTree } from "@/server/storage/files";
import { INPUT_SLOTS, JobPaths } from "@/server/storage/paths";

export interface RunnerDeps {
  store: JobStore;
  config: AppConfig;
  engine: ImagingEngine;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Aborted when the worker is shutting down. */
  shutdown: AbortSignal;
  /** How often to check whether the job was canceled or deleted. */
  watchIntervalMs?: number;
}

type StageOutcome = "next" | "stopped";

/**
 * Drives one claimed job through its remaining stages. The job's database state is the
 * source of truth: if it stops matching the stage being run (canceled or deleted from
 * the web process), the native work is aborted and nothing is published.
 */
export async function runJob(deps: RunnerDeps, claimed: Job): Promise<void> {
  const paths = new JobPaths(deps.config.jobsDir, claimed.id);
  await fsp.mkdir(paths.workDir, { recursive: true });
  await fsp.mkdir(paths.outputDir, { recursive: true });

  let state: JobState = claimed.state;
  if (state === "merging") {
    if ((await runMerge(deps, claimed, paths)) === "stopped") return;
    state = "rendering_preview";
  }
  if (state === "rendering_preview") {
    await runPreview(deps, claimed, paths);
  }
}

/**
 * Runs `work` with an abort signal that fires on shutdown, on the stage deadline, or when
 * the job leaves `expected` in the database.
 */
async function supervised<T>(
  deps: RunnerDeps,
  jobId: string,
  expected: JobState,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onShutdown = () => controller.abort(new Error("shutdown"));
  deps.shutdown.addEventListener("abort", onShutdown, { once: true });
  const watch = setInterval(() => {
    if (deps.store.get(jobId)?.state !== expected) controller.abort(new Error("canceled"));
  }, deps.watchIntervalMs ?? 1000);
  try {
    return await work(controller.signal);
  } finally {
    clearInterval(watch);
    deps.shutdown.removeEventListener("abort", onShutdown);
  }
}

function stillIn(deps: RunnerDeps, jobId: string, state: JobState): boolean {
  return deps.store.get(jobId)?.state === state;
}

/** Called when the job left the active stage underneath us. */
async function handleStopped(deps: RunnerDeps, jobId: string, paths: JobPaths): Promise<void> {
  // On shutdown, leave files and state alone; startup reconciliation marks it interrupted.
  if (deps.shutdown.aborted) return;
  deps.log("job_stopped", { jobId, state: deps.store.get(jobId)?.state ?? "deleted" });
  await removeTree(paths.root);
}

/** Log fields for a failure: the message, plus native tool output when the engine kept it. */
function errorFields(error: unknown): Record<string, unknown> {
  const detail = (error as { logDetail?: unknown } | null)?.logDetail;
  return typeof detail === "string" ? { error: String(error), detail } : { error: String(error) };
}

function userFacing(error: unknown, fallback: string): { code: string; message: string } {
  if (error instanceof EngineError) return { code: error.code, message: error.userMessage };
  return { code: "internal_error", message: fallback };
}

async function runMerge(deps: RunnerDeps, job: Job, paths: JobPaths): Promise<StageOutcome> {
  const { store, config, engine, log } = deps;
  const started = Date.now();
  const tmp = `${paths.workDir}/merged.dng`;
  const inputs = INPUT_SLOTS.map((slot) => paths.input(slot));

  let result;
  try {
    result = await supervised(deps, job.id, "merging", (signal) =>
      engine.merge({ inputs, output: tmp, workDir: paths.workDir, signal, timeoutMs: config.stageTimeoutMs }),
    );
    const size = await fileSize(tmp);
    // Size is a floor. Decoding the DNG to prove it is valid belongs to the real engine.
    if (!size) throw new EngineError("invalid_output", "The merge produced no usable DNG.");
  } catch (error) {
    if (deps.shutdown.aborted || !stillIn(deps, job.id, "merging")) {
      await handleStopped(deps, job.id, paths);
      return "stopped";
    }
    log("merge_failed", { jobId: job.id, engine: engine.name, ms: Date.now() - started, ...errorFields(error) });
    const { code, message } = userFacing(error, "The merge failed unexpectedly. Check that all three files come from one bracket and try again.");
    store.transition(job.id, "merging", "failed", { errorCode: code, errorMessage: message, retryable: false });
    await removeTree(paths.root);
    return "stopped";
  }

  await fsp.rename(tmp, paths.dng);
  store.setArtifact(job.id, "dng", (await fileSize(paths.dng)) ?? null);
  store.setManifest(job.id, {
    inputs: store.inputs(job.id).map((i) => ({ slot: i.slot, sha256: i.sha256, bytes: i.bytes })),
    merge: { ...result, ms: Date.now() - started },
  });
  log("merge_done", { jobId: job.id, engine: engine.name, ms: Date.now() - started });

  if (!store.transition(job.id, "merging", "rendering_preview", { nextStage: "preview" })) {
    await handleStopped(deps, job.id, paths);
    return "stopped";
  }
  return "next";
}

async function runPreview(deps: RunnerDeps, job: Job, paths: JobPaths): Promise<void> {
  const { store, config, engine, log } = deps;
  const started = Date.now();
  const tmp = `${paths.workDir}/preview.jpg`;

  try {
    await supervised(deps, job.id, "rendering_preview", (signal) =>
      engine.renderPreview({ dng: paths.dng, output: tmp, workDir: paths.workDir, signal, timeoutMs: config.stageTimeoutMs }),
    );
    if (!(await fileSize(tmp))) throw new EngineError("invalid_output", "The preview renderer produced no image.");
  } catch (error) {
    if (deps.shutdown.aborted || !stillIn(deps, job.id, "rendering_preview")) {
      await handleStopped(deps, job.id, paths);
      return;
    }
    log("preview_failed", { jobId: job.id, engine: engine.name, ms: Date.now() - started, ...errorFields(error) });
    const { message } = userFacing(error, "The preview couldn't be rendered.");
    // The DNG is still good: keep it downloadable and allow a preview-only retry.
    store.transition(job.id, "rendering_preview", "raw_ready_preview_failed", {
      nextStage: "preview",
      errorCode: "preview_failed",
      errorMessage: message,
      retryable: true,
    });
    await fsp.rm(tmp, { force: true });
    return;
  }

  await fsp.rename(tmp, paths.jpeg);
  store.setArtifact(job.id, "jpeg", (await fileSize(paths.jpeg)) ?? null);
  log("preview_done", { jobId: job.id, engine: engine.name, ms: Date.now() - started });

  if (!store.transition(job.id, "rendering_preview", "complete", { nextStage: null })) {
    await handleStopped(deps, job.id, paths);
    return;
  }
  // Full success: inputs and scratch files are no longer needed.
  await removeTree(paths.inputsDir);
  await removeTree(paths.workDir);
}
