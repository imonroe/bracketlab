import path from "node:path";
import { bracketPolicyFromEnv, type BracketPolicy } from "@/imaging/bracket";

const MiB = 1024 * 1024;

export interface AppConfig {
  /** Root of the persistent volume. Holds the SQLite database and per-job folders. */
  dataDir: string;
  dbPath: string;
  jobsDir: string;
  batchesDir: string;
  maxFileBytes: number;
  maxJobBytes: number;
  maxBatchBytes: number;
  maxBatchFiles: number;
  /** Batches merging at once. Each one queues all its sets, so keep this small. */
  maxActiveBatches: number;
  /** Maximum number of jobs waiting in the queue before new starts are refused. */
  maxQueuedJobs: number;
  retentionMs: number;
  /** Abandoned jobs that never left the uploading state expire after this long. */
  uploadIdleMs: number;
  /** Deadline for a single native processing stage. */
  stageTimeoutMs: number;
  workerPollMs: number;
  janitorIntervalMs: number;
  /** The health check fails when the worker heartbeat is older than this. */
  workerStaleMs: number;
  /**
   * Reading exposure metadata at upload, which needs ExifTool. On with the native engine;
   * off for the fake and unavailable engines, which then get structural checks only.
   */
  metadata: { exiftool: string; policy: BracketPolicy; timeoutMs: number } | null;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  // Runtime-only path: keep the bundler from tracing the whole project.
  const dataDir = path.resolve(/*turbopackIgnore: true*/ process.env.BRACKETLAB_DATA_DIR ?? "./data");
  return {
    dataDir,
    dbPath: path.join(dataDir, "bracketlab.sqlite"),
    jobsDir: path.join(dataDir, "jobs"),
    batchesDir: path.join(dataDir, "batches"),
    maxFileBytes: intFromEnv("BRACKETLAB_MAX_FILE_MIB", 200) * MiB,
    maxJobBytes: intFromEnv("BRACKETLAB_MAX_JOB_MIB", 600) * MiB,
    maxBatchBytes: intFromEnv("BRACKETLAB_MAX_BATCH_MIB", 4096) * MiB,
    maxBatchFiles: intFromEnv("BRACKETLAB_MAX_BATCH_FILES", 150),
    maxActiveBatches: intFromEnv("BRACKETLAB_MAX_ACTIVE_BATCHES", 2),
    maxQueuedJobs: intFromEnv("BRACKETLAB_MAX_QUEUED_JOBS", 5),
    retentionMs: intFromEnv("BRACKETLAB_RETENTION_HOURS", 24) * 60 * 60 * 1000,
    uploadIdleMs: intFromEnv("BRACKETLAB_UPLOAD_IDLE_MINUTES", 60) * 60 * 1000,
    stageTimeoutMs: intFromEnv("BRACKETLAB_STAGE_TIMEOUT_SECONDS", 600) * 1000,
    workerPollMs: intFromEnv("BRACKETLAB_WORKER_POLL_MS", 1000),
    janitorIntervalMs: intFromEnv("BRACKETLAB_JANITOR_INTERVAL_SECONDS", 300) * 1000,
    workerStaleMs: intFromEnv("BRACKETLAB_WORKER_STALE_SECONDS", 30) * 1000,
    metadata:
      (process.env.BRACKETLAB_ENGINE ?? "unavailable") === "native"
        ? {
            exiftool: process.env.BRACKETLAB_EXIFTOOL ?? "exiftool",
            policy: bracketPolicyFromEnv(),
            timeoutMs: 30_000,
          }
        : null,
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test hook: forget the cached config so environment changes take effect. */
export function resetConfig(): void {
  cached = undefined;
}
