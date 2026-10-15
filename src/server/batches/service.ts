import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { formatShutter, type BracketIssue } from "@/imaging/bracket";
import { matchBrackets, type MatchFile, type MatchResult } from "@/imaging/grouping";
import { readExposures, type FileExposure } from "@/imaging/metadata";
import type { AppConfig } from "../config";
import { apiError, notFound } from "../http";
import { generateToken, hashToken, presentedToken, tokenMatches } from "../jobs/auth";
import { publicExposure, retryPreview, uploadDisplayName, type PublicInput } from "../jobs/service";
import { isActive } from "../jobs/states";
import type { Job, JobStore } from "../jobs/store";
import { TooLargeError, removeTree, streamToFile } from "../storage/files";
import { BatchPaths, JobPaths, isJobId } from "../storage/paths";
import type { Batch, BatchFile, BatchStore } from "./store";

export interface BatchDeps {
  batches: BatchStore;
  jobs: JobStore;
  config: AppConfig;
}

export interface PublicBatchFile {
  id: string;
  name: string;
  bytes: number;
  exposure: PublicInput["exposure"];
}

export interface PublicSet {
  key: string;
  label: string;
  /** In capture order. */
  fileIds: string[];
  /** Darkest to brightest. */
  order: { fileId: string; shutter?: string; evOffset: number }[];
  spanSeconds: number;
  warnings: BracketIssue[];
}

export interface PublicBatchJob {
  id: string;
  label: string;
  state: Job["state"];
  /** Merged and done with its preview, so it is in the ZIP. */
  finished: boolean;
  stateChangedAt: number;
  error: { code: string; message: string; retryable: boolean } | null;
  artifacts: { dng: { bytes: number } | null; jpeg: { bytes: number } | null };
}

export interface PublicBatch {
  id: string;
  state: Batch["state"];
  createdAt: number;
  expiresAt: number;
  limits: { maxFileBytes: number; maxBatchBytes: number; maxBatchFiles: number };
  /** Files waiting in an open batch. */
  files: PublicBatchFile[];
  /** The proposed sets and leftovers, while the batch is open. */
  review: { sets: PublicSet[]; unplaced: { fileId: string; reason: string }[] } | null;
  /** One per submitted set. */
  jobs: PublicBatchJob[];
}

export function createBatch({ batches, config }: BatchDeps): { batch: Batch; token: string } {
  const token = generateToken();
  return { batch: batches.create(hashToken(token), config.retentionMs), token };
}

/** Resolves the batch only if the request carries its capability token. */
export function authorizeBatch({ batches }: BatchDeps, request: Request, batchId: string): Batch | Response {
  if (!isJobId(batchId)) return notFound();
  const batch = batches.get(batchId);
  const token = presentedToken(request, batchId, "batches");
  if (!batch || !token || !tokenMatches(token, batch.tokenHash)) return notFound();
  return batch;
}

/** File stem safe for a ZIP entry and a download name. */
function stem(name: string): string {
  return (
    name
      .replace(/\.[^.]*$/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[._]+/, "")
      .slice(0, 60) || "image"
  );
}

/** "DSC01039-DSC01041", from the first and last frames of a set. */
function setLabel(names: string[]): string {
  const first = stem(names[0]);
  const last = stem(names[names.length - 1]);
  return first === last ? first : `${first}-${last}`;
}

/** Per-file problems known before matching: unreadable metadata and duplicates. */
function fileIssues(files: BatchFile[]): Map<string, BracketIssue[]> {
  const issues = new Map<string, BracketIssue[]>();
  const add = (id: string, issue: BracketIssue) => issues.set(id, [...(issues.get(id) ?? []), issue]);
  const seen = new Map<string, BatchFile>();
  for (const f of files) {
    if (f.metadataError) {
      add(f.id, { code: "metadata_unreadable", message: `${f.originalName} couldn't be read. It may be damaged or not a RAW file.` });
    }
    const first = seen.get(f.sha256);
    if (first) {
      add(f.id, { code: "duplicate_input", message: `${f.originalName} is an exact copy of ${first.originalName}.` });
    } else {
      seen.set(f.sha256, f);
    }
  }
  return issues;
}

/**
 * The proposed sets. Without metadata checks (the fake and unavailable engines, for
 * development) files are simply taken three at a time in name order.
 */
export function proposeSets(config: AppConfig, files: BatchFile[]): MatchResult {
  const issues = fileIssues(files);
  if (!config.metadata) {
    const usable = files.filter((f) => !issues.has(f.id)).sort((a, b) => a.originalName.localeCompare(b.originalName));
    const whole = usable.length - (usable.length % 3);
    const sets = [];
    for (let i = 0; i < whole; i += 3) {
      const triple = usable.slice(i, i + 3);
      sets.push({
        key: triple.map((f) => f.id).join(","),
        fileIds: triple.map((f) => f.id),
        order: triple.map((f) => ({ fileId: f.id, evOffset: 0 })),
        startedAt: 0,
        spanSeconds: 0,
        warnings: [],
      });
    }
    return {
      sets,
      unplaced: [
        ...files.filter((f) => issues.has(f.id)).map((f) => ({ fileId: f.id, reason: issues.get(f.id)!.map((i) => i.message).join(" ") })),
        ...usable.slice(whole).map((f) => ({ fileId: f.id, reason: "Left over after grouping in threes." })),
      ],
    };
  }

  const matchFiles: MatchFile[] = files.map((f) => ({
    id: f.id,
    name: f.originalName,
    exposure: f.exposure,
    issues: issues.get(f.id) ?? [],
  }));
  return matchBrackets(matchFiles, { policy: config.metadata.policy });
}

/** Unique labels for a list of sets, in order: a repeated name gets "-2", "-3", ... */
function labelSets(sets: MatchResult["sets"], byId: Map<string, BatchFile>): string[] {
  const used = new Map<string, number>();
  return sets.map((set) => {
    const base = setLabel(set.fileIds.map((id) => byId.get(id)!.originalName));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

function publicJob(job: Job): PublicBatchJob {
  return {
    id: job.id,
    label: job.label ?? job.id,
    state: job.state,
    finished: isFinished(job),
    stateChangedAt: job.stateChangedAt,
    error: job.errorCode === null ? null : { code: job.errorCode, message: job.errorMessage ?? "", retryable: job.retryable },
    artifacts: {
      dng: job.dngBytes === null ? null : { bytes: job.dngBytes },
      jpeg: job.jpegBytes === null ? null : { bytes: job.jpegBytes },
    },
  };
}

export function toPublicBatch(deps: BatchDeps, batch: Batch): PublicBatch {
  const { config } = deps;
  const files = batch.state === "open" ? deps.batches.files(batch.id) : [];
  let review: PublicBatch["review"] = null;
  if (batch.state === "open") {
    const byId = new Map(files.map((f) => [f.id, f]));
    const proposal = proposeSets(config, files);
    const labels = labelSets(proposal.sets, byId);
    review = {
      sets: proposal.sets.map((set, i) => ({
        key: set.key,
        label: labels[i],
        fileIds: set.fileIds,
        order: set.order.map((o) => {
          const time = byId.get(o.fileId)?.exposure?.exposureTime;
          return { fileId: o.fileId, evOffset: o.evOffset, shutter: time === undefined ? undefined : formatShutter(time) };
        }),
        spanSeconds: set.spanSeconds,
        warnings: set.warnings,
      })),
      unplaced: proposal.unplaced,
    };
  }
  return {
    id: batch.id,
    state: batch.state,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    limits: { maxFileBytes: config.maxFileBytes, maxBatchBytes: config.maxBatchBytes, maxBatchFiles: config.maxBatchFiles },
    files: files.map((f) => ({ id: f.id, name: f.originalName, bytes: f.bytes, exposure: publicExposure(f.exposure) })),
    review,
    jobs: batch.state === "submitted" ? deps.jobs.forBatch(batch.id).map(publicJob) : [],
  };
}

const mib = (n: number) => Math.floor(n / (1024 * 1024));

export async function uploadBatchFile(deps: BatchDeps, batch: Batch, request: Request): Promise<PublicBatchFile | Response> {
  const { config, batches } = deps;
  if (batch.state !== "open") return apiError(409, "batch_closed", "This batch has already been submitted.");
  if (!request.body) return apiError(400, "empty_body", "The upload body is empty.");

  const totals = batches.totals(batch.id);
  if (totals.count >= config.maxBatchFiles) {
    return apiError(413, "too_many_files", `A batch can hold at most ${config.maxBatchFiles} files.`);
  }
  const limit = Math.min(config.maxFileBytes, config.maxBatchBytes - totals.bytes);
  const declared = Number(request.headers.get("content-length"));
  const tooLarge = () =>
    apiError(
      413,
      "too_large",
      limit < config.maxFileBytes
        ? `This file would push the batch past its ${mib(config.maxBatchBytes)} MiB total.`
        : `Files may be at most ${mib(config.maxFileBytes)} MiB.`,
    );
  if (limit <= 0 || (Number.isFinite(declared) && declared > limit)) return tooLarge();

  const fileId = randomUUID();
  const dest = new BatchPaths(config.batchesDir, batch.id).file(fileId);
  let written;
  try {
    written = await streamToFile(request.body, dest, limit, request.signal);
  } catch (error) {
    if (error instanceof TooLargeError) return tooLarge();
    if (request.signal.aborted) return apiError(499, "aborted", "The upload was interrupted.");
    throw error;
  }

  let exposure: FileExposure | null = null;
  let metadataError: string | null = null;
  if (config.metadata) {
    try {
      [exposure] = await readExposures([dest], {
        exiftool: config.metadata.exiftool,
        signal: request.signal,
        timeoutMs: config.metadata.timeoutMs,
      });
    } catch (error) {
      metadataError = String(error);
    }
  }

  const name = uploadDisplayName(request, "image.ARW");
  const result = batches.addFile(
    batch.id,
    { id: fileId, originalName: name, ...written, exposure, metadataError },
    { maxFiles: config.maxBatchFiles, maxBytes: config.maxBatchBytes },
  );
  if (result !== "added") {
    await fsp.rm(dest, { force: true });
    if (result === "closed") return apiError(409, "batch_closed", "This batch has already been submitted.");
    if (result === "too_many_files") return apiError(413, "too_many_files", `A batch can hold at most ${config.maxBatchFiles} files.`);
    return tooLarge();
  }
  return { id: fileId, name, bytes: written.bytes, exposure: publicExposure(exposure) };
}

export async function removeBatchFile(deps: BatchDeps, batch: Batch, fileId: string): Promise<Response | null> {
  if (!isJobId(fileId)) return apiError(404, "not_found", "File not found.");
  if (batch.state !== "open") return apiError(409, "batch_closed", "This batch has already been submitted.");
  if (!deps.batches.removeFile(batch.id, fileId)) return apiError(404, "not_found", "File not found.");
  await fsp.rm(new BatchPaths(deps.config.batchesDir, batch.id).file(fileId), { force: true });
  return null;
}

/**
 * Turns the reviewed sets into jobs. `include` lists the keys of the sets to merge, as
 * the page showed them; if the files changed since, the keys no longer match and the
 * request is refused so nothing unreviewed gets merged. Files not in an included set are
 * deleted.
 */
export async function submitBatch(deps: BatchDeps, batch: Batch, include: unknown): Promise<PublicBatch | Response> {
  const { config, batches, jobs } = deps;
  if (batch.state !== "open") return apiError(409, "batch_closed", "This batch has already been submitted.");
  if (!Array.isArray(include) || include.length === 0 || !include.every((k) => typeof k === "string")) {
    return apiError(422, "nothing_selected", "Choose at least one set to merge.");
  }
  if (batches.countActive() >= config.maxActiveBatches) {
    return apiError(503, "queue_full", "Another batch is still merging. Try again when it finishes.");
  }

  const files = batches.files(batch.id);
  const byId = new Map(files.map((f) => [f.id, f]));
  const proposal = proposeSets(config, files);
  const labels = labelSets(proposal.sets, byId);
  const wanted = new Set(include as string[]);
  const chosen = proposal.sets.map((set, i) => ({ set, label: labels[i] })).filter(({ set }) => wanted.has(set.key));
  if (chosen.length !== wanted.size) {
    return apiError(409, "batch_changed", "The files changed since you reviewed them. Check the sets again.");
  }

  const batchPaths = new BatchPaths(config.batchesDir, batch.id);
  const planned = chosen.map(({ set, label }) => ({ id: randomUUID(), set, label }));

  // Move files into their jobs before the jobs exist in the database, so the worker can
  // never claim a job whose inputs aren't in place yet.
  for (const { id, set } of planned) {
    const jobPaths = new JobPaths(config.jobsDir, id);
    await fsp.mkdir(jobPaths.inputsDir, { recursive: true });
    for (const [slot, fileId] of set.fileIds.entries()) {
      await fsp.rename(batchPaths.file(fileId), jobPaths.input(slot as 0 | 1 | 2));
    }
  }

  const committed = batches.transaction(() => {
    if (!batches.markSubmitted(batch.id, config.retentionMs)) return false;
    const expiresAt = batches.get(batch.id)!.expiresAt;
    for (const { id, set, label } of planned) {
      jobs.createBatchJob({
        id,
        batchId: batch.id,
        tokenHash: batch.tokenHash,
        label,
        expiresAt,
        inputs: set.fileIds.map((fileId, slot) => {
          const f = byId.get(fileId)!;
          return {
            slot,
            originalName: f.originalName,
            bytes: f.bytes,
            sha256: f.sha256,
            exposure: f.exposure,
            metadataError: f.metadataError,
          };
        }),
      });
    }
    return true;
  });
  if (!committed) {
    // A concurrent submit won. Its jobs own the batch now; drop this attempt's copies.
    for (const { id } of planned) await removeTree(new JobPaths(config.jobsDir, id).root);
    return apiError(409, "batch_closed", "This batch has already been submitted.");
  }

  // Anything not merged (unplaced files, excluded sets) is no longer needed.
  await removeTree(batchPaths.root);
  return toPublicBatch(deps, batches.get(batch.id)!);
}

function batchJob(deps: BatchDeps, batch: Batch, jobId: string): Job | Response {
  if (!isJobId(jobId)) return apiError(404, "not_found", "Set not found.");
  const job = deps.jobs.get(jobId);
  if (!job || job.batchId !== batch.id) return apiError(404, "not_found", "Set not found.");
  return job;
}

export function retryBatchJob(deps: BatchDeps, batch: Batch, jobId: string): PublicBatchJob | Response {
  const job = batchJob(deps, batch, jobId);
  if (job instanceof Response) return job;
  if (job.state === "raw_ready_preview_failed") {
    const result = retryPreview(deps.jobs, job);
    return result instanceof Response ? result : publicJob(result);
  }
  if (job.state === "failed" && job.retryable) {
    const result = deps.jobs.transition(job.id, "failed", "queued", { errorCode: null, errorMessage: null });
    return publicJob(result ?? job);
  }
  return apiError(409, "not_retryable", "This set can't be retried. Its files didn't merge.");
}

export function batchArtifactPath(deps: BatchDeps, batch: Batch, jobId: string, kind: "dng" | "jpeg"): { file: string; label: string } | Response {
  const job = batchJob(deps, batch, jobId);
  if (job instanceof Response) return job;
  const paths = new JobPaths(deps.config.jobsDir, job.id);
  if (kind === "dng" && job.dngBytes !== null) return { file: paths.dng, label: job.label ?? job.id };
  if (kind === "jpeg" && job.jpegBytes !== null) return { file: paths.jpeg, label: job.label ?? job.id };
  return apiError(404, "not_ready", "That file isn't available.");
}

/**
 * Streams one ZIP of every finished set: "<label>.dng" at the top and
 * "previews/<label>.jpg" beside them. DNG and JPEG data don't compress, so entries are
 * stored as-is, which also keeps memory and CPU flat for multi-gigabyte batches.
 */
/** A set whose files won't change any more: merged, with its preview rendered or failed. */
export function isFinished(job: Pick<Job, "state" | "dngBytes">): boolean {
  return (job.state === "complete" || job.state === "raw_ready_preview_failed") && job.dngBytes !== null;
}

export function batchZip(deps: BatchDeps, batch: Batch): Response {
  // Only finished sets, so a set mid-preview never ships without its JPEG.
  const done = deps.jobs.forBatch(batch.id).filter(isFinished);
  if (done.length === 0) return apiError(404, "not_ready", "No sets have finished merging yet.");

  const zip = new ZipFile();
  for (const job of done) {
    const paths = new JobPaths(deps.config.jobsDir, job.id);
    const label = job.label ?? job.id;
    zip.addFile(paths.dng, `${label}.dng`, { compress: false });
    if (job.jpegBytes !== null) zip.addFile(paths.jpeg, `previews/${label}.jpg`, { compress: false });
  }
  zip.end();

  const date = new Date(batch.createdAt).toISOString().slice(0, 10);
  return new Response(Readable.toWeb(zip.outputStream as Readable) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="bracketlab-${date}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Deletes the batch, its sets and every file they own. */
export async function deleteBatch(deps: BatchDeps, batch: Batch): Promise<void> {
  const jobs = deps.jobs.forBatch(batch.id);
  // Stop running merges first so the worker stops writing into the job folders.
  for (const job of jobs) if (isActive(job.state)) deps.jobs.transition(job.id, job.state, "canceled");
  deps.batches.delete(batch.id);
  for (const job of jobs) await removeTree(new JobPaths(deps.config.jobsDir, job.id).root);
  await removeTree(new BatchPaths(deps.config.batchesDir, batch.id).root);
}

/** Exposed for streaming single artifacts from route handlers. */
export function fileStream(file: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
}
