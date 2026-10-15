import fsp from "node:fs/promises";
import { formatShutter } from "@/imaging/bracket";
import { readExposures, type FileExposure } from "@/imaging/metadata";
import { preflight, type PreflightIssue } from "@/imaging/preflight";
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
  inputs: PublicInput[];
  /** The pre-Merge check (PRD F2). Merge is allowed only when `ready` is true. */
  bracket: {
    ready: boolean;
    errors: PreflightIssue[];
    warnings: PreflightIssue[];
    /** Slots from darkest to brightest with EV offsets, once the bracket checks out. */
    order: { slot: number; evOffset: number }[] | null;
  };
  artifacts: Record<ArtifactKind, { bytes: number } | null>;
  limits: { maxFileBytes: number; maxJobBytes: number };
}

export interface PublicInput {
  slot: number;
  name: string;
  bytes: number;
  /** Shown next to the file once its metadata is read, e.g. "1/400s · ISO 100 · f/8". */
  exposure: { model?: string; shutter?: string; iso?: number; fNumber?: number; focalLength?: number } | null;
  issues: PreflightIssue[];
}

export function publicExposure(e: FileExposure | null): PublicInput["exposure"] {
  if (!e) return null;
  return {
    model: e.model,
    shutter: e.exposureTime === undefined ? undefined : formatShutter(e.exposureTime),
    iso: e.iso,
    fNumber: e.fNumber,
    focalLength: e.focalLength,
  };
}

export function toPublicJob(store: JobStore, config: AppConfig, job: Job): PublicJob {
  const inputs = store.inputs(job.id);
  const check = preflight(inputs, config.metadata?.policy ?? null);
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
    inputs: inputs.map((i) => ({
      slot: i.slot,
      name: i.originalName,
      bytes: i.bytes,
      exposure: publicExposure(i.exposure),
      issues: check.byInput[i.slot] ?? [],
    })),
    bracket: {
      ready: check.errors.length === 0,
      // The count message is noise while files are still arriving.
      errors: check.errors.filter((e) => e.code !== "wrong_count"),
      warnings: check.warnings,
      order: check.order,
    },
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
export function uploadDisplayName(request: Request, fallback: string): string {
  const raw = request.headers.get("x-filename");
  let name = fallback;
  if (raw) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  // Strip control characters so names are safe to render and log.
  return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME_LENGTH) || fallback;
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

  // Read the exposure tags now, so the page can show problems before Merge (PRD F2).
  let exposure: FileExposure | null = null;
  let metadataError: string | null = null;
  if (config.metadata) {
    try {
      [exposure] = await readExposures([dest], {
        exiftool: config.metadata.exiftool,
        signal: request.signal,
        timeoutMs: config.metadata.timeoutMs,
      });
      // An unreadable file comes back as an empty record; preflight reports it per file.
    } catch (error) {
      metadataError = String(error);
    }
  }

  try {
    return store.putInput(job.id, {
      slot,
      originalName: uploadDisplayName(request, `input-${slot + 1}`),
      ...written,
      exposure,
      metadataError,
    });
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

  const check = preflight(store.inputs(job.id), config.metadata?.policy ?? null);
  if (check.errors.length > 0) {
    const [first] = check.errors;
    const message = check.errors.map((e) => e.message).join(" ");
    store.transition(job.id, "validating", "uploading", { errorCode: first.code, errorMessage: message });
    return apiError(422, first.code, message);
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
