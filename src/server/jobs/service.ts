import fsp from "node:fs/promises";
import { structuralPreflight } from "@/imaging/preflight";
import type { AppConfig } from "../config";
import { apiError, notFound } from "../http";
import { TooLargeError, removeTree, streamToFile } from "../storage/files";
import { JobPaths, isJobId, type InputSlot } from "../storage/paths";
import { generateToken, hashToken, presentedToken, tokenMatches } from "./auth";
import { isActive, isCancelable } from "./states";
import type { ArtifactKind, Job, JobInput, JobStore } from "./store";

/** What the browser sees. Never includes the token hash. */
export interface PublicJob {
  id: string;
  state: Job["state"];
  createdAt: number;
  stateChangedAt: number;
  expiresAt: number;
  queuePosition: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
  inputs: { slot: number; name: string; bytes: number }[];
  artifacts: Record<ArtifactKind, { bytes: number } | null>;
  limits: { maxFileBytes: number; maxJobBytes: number };
}

export function toPublicJob(store: JobStore, config: AppConfig, job: Job): PublicJob {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    stateChangedAt: job.stateChangedAt,
    expiresAt: job.expiresAt,
    queuePosition: store.queuePosition(job.id),
    error:
      job.errorCode === null
        ? null
        : { code: job.errorCode, message: job.errorMessage ?? "", retryable: job.retryable },
    inputs: store.inputs(job.id).map((i) => ({ slot: i.slot, name: i.originalName, bytes: i.bytes })),
    artifacts: {
      dng: job.dngBytes === null ? null : { bytes: job.dngBytes },
      jpeg: job.jpegBytes === null ? null : { bytes: job.jpegBytes },
    },
    limits: { maxFileBytes: config.maxFileBytes, maxJobBytes: config.maxJobBytes },
  };
}

export function createJob(store: JobStore, config: AppConfig): { job: Job; token: string } {
  const token = generateToken();
  const job = store.create(hashToken(token), config.retentionMs);
  return { job, token };
}

/** Resolves the job only if the request carries its capability token. */
export function authorize(store: JobStore, request: Request, jobId: string): Job | Response {
  if (!isJobId(jobId)) return notFound();
  const job = store.get(jobId);
  const token = presentedToken(request, jobId);
  if (!job || !token || !tokenMatches(token, job.tokenHash)) return notFound();
  return job;
}

const MAX_NAME_LENGTH = 255;

/** Display name from the X-Filename header. Used for UI only, never for paths. */
function displayName(request: Request, slot: InputSlot): string {
  const raw = request.headers.get("x-filename");
  let name = `input-${slot + 1}`;
  if (raw) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  // Strip control characters so names are safe to render and log.
  return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME_LENGTH) || `input-${slot + 1}`;
}

export async function uploadInput(
  store: JobStore,
  config: AppConfig,
  job: Job,
  slot: InputSlot,
  request: Request,
): Promise<JobInput | Response> {
  if (job.state !== "uploading") {
    return apiError(409, "not_uploading", "This job is no longer accepting files.");
  }
  if (!request.body) return apiError(400, "empty_body", "The upload body is empty.");

  const declared = Number(request.headers.get("content-length"));
  const otherBytes = store
    .inputs(job.id)
    .filter((i) => i.slot !== slot)
    .reduce((sum, i) => sum + i.bytes, 0);
  const limit = Math.min(config.maxFileBytes, config.maxJobBytes - otherBytes);
  // Content-Length is a hint for failing fast; the stream is still metered.
  if (Number.isFinite(declared) && declared > limit) {
    return apiError(413, "too_large", tooLargeMessage(config, limit));
  }

  const paths = new JobPaths(config.jobsDir, job.id);
  const dest = paths.input(slot);
  let written;
  try {
    written = await streamToFile(request.body, dest, limit, request.signal);
  } catch (error) {
    if (error instanceof TooLargeError) {
      return apiError(413, "too_large", tooLargeMessage(config, limit));
    }
    if (request.signal.aborted) return apiError(499, "aborted", "The upload was interrupted.");
    throw error;
  }

  try {
    return store.putInput(job.id, { slot, originalName: displayName(request, slot), ...written });
  } catch {
    // The job was canceled or deleted while the bytes were in flight.
    await fsp.rm(dest, { force: true });
    return apiError(409, "not_uploading", "This job is no longer accepting files.");
  }
}

function tooLargeMessage(config: AppConfig, limit: number): string {
  const mib = (n: number) => Math.floor(n / (1024 * 1024));
  return limit < config.maxFileBytes
    ? `This file would push the job past its ${mib(config.maxJobBytes)} MiB total limit.`
    : `Files may be at most ${mib(config.maxFileBytes)} MiB.`;
}

/**
 * Validates and queues the job. Idempotent: starting a job that is already queued or
 * processing returns it unchanged. A retryable failure is re-queued at its next stage.
 */
export function startJob(store: JobStore, config: AppConfig, job: Job): Job | Response {
  if (job.state === "failed" && job.retryable) {
    if (store.countQueued() >= config.maxQueuedJobs) return queueFull();
    return store.transition(job.id, "failed", "queued", { errorCode: null, errorMessage: null }) ?? job;
  }
  if (job.state !== "uploading") {
    if (job.state === "failed" || job.state === "canceled" || job.state === "expired") {
      return apiError(409, "not_startable", "This job can't be started again. Start a new merge.");
    }
    return job;
  }

  const validating = store.transition(job.id, "uploading", "validating", {
    errorCode: null,
    errorMessage: null,
  });
  if (!validating) return store.get(job.id) ?? job;

  const preflight = structuralPreflight(store.inputs(job.id));
  if (preflight.errors.length > 0) {
    const [first] = preflight.errors;
    store.transition(job.id, "validating", "uploading", {
      errorCode: first.code,
      errorMessage: preflight.errors.map((e) => e.message).join(" "),
    });
    return apiError(422, first.code, preflight.errors.map((e) => e.message).join(" "));
  }

  if (store.countQueued() >= config.maxQueuedJobs) {
    store.transition(job.id, "validating", "uploading");
    return queueFull();
  }

  return store.transition(job.id, "validating", "queued", { nextStage: "merge" }) ?? job;
}

function queueFull(): Response {
  return apiError(503, "queue_full", "The processing queue is full. Try again in a few minutes.");
}

/**
 * Cancels the job. If a native process is running, the worker notices the state change,
 * kills the process group and removes the job's files. Otherwise files go immediately.
 */
export async function cancelJob(store: JobStore, config: AppConfig, job: Job): Promise<Job | Response> {
  if (!isCancelable(job.state)) {
    return apiError(409, "not_cancelable", "This job has already finished.");
  }
  const canceled = store.transition(job.id, job.state, "canceled", {
    errorCode: null,
    errorMessage: null,
  });
  if (!canceled) return apiError(409, "conflict", "The job changed state. Refresh and try again.");
  if (!isActive(job.state)) await removeTree(new JobPaths(config.jobsDir, job.id).root);
  return canceled;
}

export function retryPreview(store: JobStore, job: Job): Job | Response {
  if (job.state !== "raw_ready_preview_failed") {
    return apiError(409, "not_retryable", "Only a failed preview can be retried.");
  }
  return (
    store.transition(job.id, "raw_ready_preview_failed", "queued", {
      nextStage: "preview",
      errorCode: null,
      errorMessage: null,
    }) ?? job
  );
}

/** Deletes the job record and every file it owns. */
export async function deleteJob(store: JobStore, config: AppConfig, job: Job): Promise<void> {
  // Signal a running worker first so it stops writing into the directory.
  if (isActive(job.state)) store.transition(job.id, job.state, "canceled");
  store.delete(job.id);
  await removeTree(new JobPaths(config.jobsDir, job.id).root);
}

export function artifactPath(config: AppConfig, job: Job, kind: ArtifactKind): string | undefined {
  const paths = new JobPaths(config.jobsDir, job.id);
  if (kind === "dng" && job.dngBytes !== null) return paths.dng;
  if (kind === "jpeg" && job.jpegBytes !== null) return paths.jpeg;
  return undefined;
}
