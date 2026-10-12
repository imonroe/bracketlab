import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import {
  ACTIVE_STATES,
  InvalidTransitionError,
  canTransition,
  type JobStage,
  type JobState,
} from "./states";

export type ArtifactKind = "dng" | "jpeg";

export interface Job {
  id: string;
  tokenHash: string;
  state: JobState;
  nextStage: JobStage | null;
  createdAt: number;
  updatedAt: number;
  stateChangedAt: number;
  queuedAt: number | null;
  expiresAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  dngBytes: number | null;
  jpegBytes: number | null;
  manifest: unknown;
}

export interface JobInput {
  slot: number;
  originalName: string;
  bytes: number;
  sha256: string;
  uploadedAt: number;
}

/** Optional column updates applied together with a state transition. */
export interface TransitionPatch {
  nextStage?: JobStage | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
  expiresAt?: number;
}

interface JobRow {
  id: string;
  token_hash: string;
  state: JobState;
  next_stage: JobStage | null;
  created_at: number;
  updated_at: number;
  state_changed_at: number;
  queued_at: number | null;
  expires_at: number;
  error_code: string | null;
  error_message: string | null;
  retryable: number;
  dng_bytes: number | null;
  jpeg_bytes: number | null;
  manifest: string | null;
}

interface InputRow {
  slot: number;
  original_name: string;
  bytes: number;
  sha256: string;
  uploaded_at: number;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    state: row.state,
    nextStage: row.next_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
    queuedAt: row.queued_at,
    expiresAt: row.expires_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === 1,
    dngBytes: row.dng_bytes,
    jpegBytes: row.jpeg_bytes,
    manifest: row.manifest === null ? null : JSON.parse(row.manifest),
  };
}

function toInput(row: InputRow): JobInput {
  return {
    slot: row.slot,
    originalName: row.original_name,
    bytes: row.bytes,
    sha256: row.sha256,
    uploadedAt: row.uploaded_at,
  };
}

/**
 * All job persistence goes through this class. State changes are compare-and-swap:
 * a transition only applies if the job is still in an expected state, so the web
 * process and the worker cannot overwrite each other (for example a cancel racing
 * the end of a merge).
 */
export class JobStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(tokenHash: string, retentionMs: number): Job {
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, token_hash, state, created_at, updated_at, state_changed_at, expires_at)
         VALUES (?, ?, 'uploading', ?, ?, ?, ?)`,
      )
      .run(id, tokenHash, now, now, now, now + retentionMs);
    return this.get(id)!;
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  inputs(id: string): JobInput[] {
    const rows = this.db
      .prepare(`SELECT * FROM job_inputs WHERE job_id = ? ORDER BY slot`)
      .all(id) as InputRow[];
    return rows.map(toInput);
  }

  /** Records (or replaces) an uploaded input. Only valid while the job is uploading. */
  putInput(id: string, input: Omit<JobInput, "uploadedAt">): JobInput {
    const now = this.now();
    const result = this.db.transaction(() => {
      const touched = this.db
        .prepare(`UPDATE jobs SET updated_at = ? WHERE id = ? AND state = 'uploading'`)
        .run(now, id);
      if (touched.changes === 0) return false;
      this.db
        .prepare(
          `INSERT INTO job_inputs (job_id, slot, original_name, bytes, sha256, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (job_id, slot) DO UPDATE SET
             original_name = excluded.original_name,
             bytes = excluded.bytes,
             sha256 = excluded.sha256,
             uploaded_at = excluded.uploaded_at`,
        )
        .run(id, input.slot, input.originalName, input.bytes, input.sha256, now);
      return true;
    })();
    if (!result) throw new Error(`Job ${id} is not accepting uploads`);
    return { ...input, uploadedAt: now };
  }

  /**
   * Moves a job to `to` if it is currently in one of `from`. Returns the updated job,
   * or undefined when the job is missing or has already moved on. Throws if the
   * requested edge is not part of the lifecycle at all, since that is a programming error.
   */
  transition(
    id: string,
    from: JobState | readonly JobState[],
    to: JobState,
    patch: TransitionPatch = {},
  ): Job | undefined {
    const fromStates = typeof from === "string" ? [from] : from;
    for (const state of fromStates) {
      if (!canTransition(state, to)) throw new InvalidTransitionError(state, to);
    }

    const now = this.now();
    const sets = ["state = @to", "updated_at = @now", "state_changed_at = @now"];
    const params: Record<string, unknown> = { id, to, now };

    if (to === "queued") sets.push("queued_at = @now");
    if (patch.nextStage !== undefined) {
      sets.push("next_stage = @nextStage");
      params.nextStage = patch.nextStage;
    }
    if (patch.errorCode !== undefined) {
      sets.push("error_code = @errorCode");
      params.errorCode = patch.errorCode;
    }
    if (patch.errorMessage !== undefined) {
      sets.push("error_message = @errorMessage");
      params.errorMessage = patch.errorMessage;
    }
    if (patch.retryable !== undefined) {
      sets.push("retryable = @retryable");
      params.retryable = patch.retryable ? 1 : 0;
    }
    if (patch.expiresAt !== undefined) {
      sets.push("expires_at = @expiresAt");
      params.expiresAt = patch.expiresAt;
    }

    const placeholders = fromStates.map((_, i) => `@from${i}`).join(", ");
    fromStates.forEach((state, i) => (params[`from${i}`] = state));

    const result = this.db
      .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id AND state IN (${placeholders})`)
      .run(params);
    return result.changes === 0 ? undefined : this.get(id);
  }

  setArtifact(id: string, kind: ArtifactKind, bytes: number | null): void {
    const column = kind === "dng" ? "dng_bytes" : "jpeg_bytes";
    this.db
      .prepare(`UPDATE jobs SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(bytes, this.now(), id);
  }

  setManifest(id: string, manifest: unknown): void {
    this.db
      .prepare(`UPDATE jobs SET manifest = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(manifest), this.now(), id);
  }

  countQueued(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'`).get() as {
      n: number;
    };
    return row.n;
  }

  /** Position in the queue, starting at 1, or null when the job is not queued. */
  queuePosition(id: string): number | null {
    const job = this.get(id);
    if (!job || job.state !== "queued" || job.queuedAt === null) return null;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE state = 'queued' AND (queued_at < ? OR (queued_at = ? AND id <= ?))`,
      )
      .get(job.queuedAt, job.queuedAt, id) as { n: number };
    return row.n;
  }

  /**
   * Atomically takes the oldest queued job and moves it into the state for its next
   * stage. Only one worker runs in v1, but the transaction keeps this safe regardless.
   */
  claimNext(): Job | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY queued_at, id LIMIT 1`)
        .get() as JobRow | undefined;
      if (!row) return undefined;
      const to: JobState = row.next_stage === "preview" ? "rendering_preview" : "merging";
      return this.transition(row.id, "queued", to, { errorCode: null, errorMessage: null });
    })();
  }

  /**
   * Called when the worker starts. Any job left in an active state was interrupted by a
   * crash or restart; mark it failed but retryable rather than silently re-running it.
   */
  reconcileInterrupted(): Job[] {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE state IN (${placeholders})`)
      .all(...ACTIVE_STATES) as JobRow[];
    const failed: Job[] = [];
    for (const row of rows) {
      const job = this.transition(row.id, row.state, "failed", {
        // A job interrupted while rendering already has its DNG, so retry the preview only.
        nextStage: row.state === "rendering_preview" && row.dng_bytes !== null ? "preview" : "merge",
        errorCode: "interrupted",
        errorMessage: "Processing was interrupted by a restart. You can retry this job.",
        retryable: true,
      });
      if (job) failed.push(job);
    }
    return failed;
  }

  /** Jobs whose retention has elapsed, plus uploads abandoned before they were started. */
  listExpirable(uploadIdleMs: number): Job[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE state NOT IN ('expired', 'merging', 'rendering_preview', 'validating')
           AND (expires_at <= ? OR (state = 'uploading' AND updated_at <= ?))`,
      )
      .all(now, now - uploadIdleMs) as JobRow[];
    return rows.map(toJob);
  }

  /** Expired rows are kept briefly so a returning browser sees "expired" rather than 404. */
  purgeExpired(olderThanMs: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE state = 'expired' AND state_changed_at <= ?`)
      .all(this.now() - olderThanMs) as { id: string }[];
    const del = this.db.prepare(`DELETE FROM jobs WHERE id = ?`);
    this.db.transaction(() => rows.forEach((r) => del.run(r.id)))();
    return rows.map((r) => r.id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id).changes > 0;
  }

  heartbeat(pid: number): void {
    this.db
      .prepare(
        `INSERT INTO worker_heartbeat (id, pid, beat_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, beat_at = excluded.beat_at`,
      )
      .run(pid, this.now());
  }

  lastHeartbeat(): { pid: number; beatAt: number } | undefined {
    const row = this.db.prepare(`SELECT pid, beat_at FROM worker_heartbeat WHERE id = 1`).get() as
      | { pid: number; beat_at: number }
      | undefined;
    return row && { pid: row.pid, beatAt: row.beat_at };
  }
}
