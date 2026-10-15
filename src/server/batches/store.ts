import { randomUUID } from "node:crypto";
import type { FileExposure } from "@/imaging/metadata";
import type { Db } from "../jobs/db";

/**
 * A batch is a shoot's worth of RAW files uploaded together. While it is open, files can
 * be added and removed and the page shows the matched brackets. Submitting it turns each
 * confirmed bracket into an ordinary job (jobs.batch_id) and closes it to changes.
 */
export type BatchState = "open" | "submitted" | "expired";

export interface Batch {
  id: string;
  tokenHash: string;
  state: BatchState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface BatchFile {
  id: string;
  batchId: string;
  originalName: string;
  bytes: number;
  sha256: string;
  uploadedAt: number;
  exposure: FileExposure | null;
  metadataError: string | null;
}

interface BatchRow {
  id: string;
  token_hash: string;
  state: BatchState;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface FileRow {
  id: string;
  batch_id: string;
  original_name: string;
  bytes: number;
  sha256: string;
  uploaded_at: number;
  metadata: string | null;
  metadata_error: string | null;
}

const toBatch = (r: BatchRow): Batch => ({
  id: r.id,
  tokenHash: r.token_hash,
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

const toFile = (r: FileRow): BatchFile => ({
  id: r.id,
  batchId: r.batch_id,
  originalName: r.original_name,
  bytes: r.bytes,
  sha256: r.sha256,
  uploadedAt: r.uploaded_at,
  exposure: r.metadata === null ? null : (JSON.parse(r.metadata) as FileExposure),
  metadataError: r.metadata_error,
});

export type AddFileResult = "added" | "closed" | "too_many_files" | "too_large";

export class BatchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** For callers that need several stores to commit together (batch submission). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(tokenHash: string, retentionMs: number): Batch {
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO batches (id, token_hash, state, created_at, updated_at, expires_at)
         VALUES (?, ?, 'open', ?, ?, ?)`,
      )
      .run(id, tokenHash, now, now, now + retentionMs);
    return this.get(id)!;
  }

  get(id: string): Batch | undefined {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(id) as BatchRow | undefined;
    return row && toBatch(row);
  }

  files(batchId: string): BatchFile[] {
    const rows = this.db
      .prepare(`SELECT * FROM batch_files WHERE batch_id = ? ORDER BY uploaded_at, rowid`)
      .all(batchId) as FileRow[];
    return rows.map(toFile);
  }

  totals(batchId: string): { count: number; bytes: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM batch_files WHERE batch_id = ?`)
      .get(batchId) as { count: number; bytes: number };
    return row;
  }

  /**
   * Records an uploaded file. The limits are checked here, inside the transaction, so
   * parallel uploads can't together slip past them.
   */
  addFile(
    batchId: string,
    file: Omit<BatchFile, "batchId" | "uploadedAt">,
    limits: { maxFiles: number; maxBytes: number },
  ): AddFileResult {
    const now = this.now();
    return this.transaction(() => {
      const batch = this.get(batchId);
      if (!batch || batch.state !== "open") return "closed";
      const totals = this.totals(batchId);
      if (totals.count + 1 > limits.maxFiles) return "too_many_files";
      if (totals.bytes + file.bytes > limits.maxBytes) return "too_large";
      this.db
        .prepare(
          `INSERT INTO batch_files (id, batch_id, original_name, bytes, sha256, uploaded_at, metadata, metadata_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          file.id,
          batchId,
          file.originalName,
          file.bytes,
          file.sha256,
          now,
          file.exposure === null ? null : JSON.stringify(file.exposure),
          file.metadataError,
        );
      this.db.prepare(`UPDATE batches SET updated_at = ? WHERE id = ?`).run(now, batchId);
      return "added";
    });
  }

  removeFile(batchId: string, fileId: string): boolean {
    return this.transaction(() => {
      const batch = this.get(batchId);
      if (!batch || batch.state !== "open") return false;
      const removed = this.db.prepare(`DELETE FROM batch_files WHERE id = ? AND batch_id = ?`).run(fileId, batchId);
      if (removed.changes > 0) {
        this.db.prepare(`UPDATE batches SET updated_at = ? WHERE id = ?`).run(this.now(), batchId);
      }
      return removed.changes > 0;
    });
  }

  /**
   * Closes the batch to changes and restarts its retention clock, since its results are
   * about to be produced. Returns false if it was no longer open. Its file rows go: the
   * files move into their sets' jobs or are deleted.
   */
  markSubmitted(batchId: string, retentionMs: number): boolean {
    const now = this.now();
    const result = this.db
      .prepare(`UPDATE batches SET state = 'submitted', updated_at = ?, expires_at = ? WHERE id = ? AND state = 'open'`)
      .run(now, now + retentionMs, batchId);
    if (result.changes === 0) return false;
    this.db.prepare(`DELETE FROM batch_files WHERE batch_id = ?`).run(batchId);
    return true;
  }

  /** Submitted batches that still have sets waiting or being merged. */
  countActive(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT b.id) AS n FROM batches b JOIN jobs j ON j.batch_id = b.id
         WHERE b.state = 'submitted' AND j.state IN ('queued', 'merging', 'rendering_preview')`,
      )
      .get() as { n: number };
    return row.n;
  }

  /** Batches past retention, plus open batches nobody has touched for `idleMs`. */
  listExpirable(idleMs: number): Batch[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM batches
         WHERE state != 'expired' AND (expires_at <= ? OR (state = 'open' AND updated_at <= ?))`,
      )
      .all(now, now - idleMs) as BatchRow[];
    return rows.map(toBatch);
  }

  expire(batchId: string): boolean {
    const now = this.now();
    return this.transaction(() => {
      const changed = this.db
        .prepare(`UPDATE batches SET state = 'expired', updated_at = ? WHERE id = ? AND state != 'expired'`)
        .run(now, batchId).changes;
      this.db.prepare(`DELETE FROM batch_files WHERE batch_id = ?`).run(batchId);
      return changed > 0;
    });
  }

  /** Drops expired batches (and, by cascade, their jobs) once the grace period passes. */
  purgeExpired(olderThanMs: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM batches WHERE state = 'expired' AND updated_at <= ?`)
      .all(this.now() - olderThanMs) as { id: string }[];
    const del = this.db.prepare(`DELETE FROM batches WHERE id = ?`);
    this.transaction(() => rows.forEach((r) => del.run(r.id)));
    return rows.map((r) => r.id);
  }

  delete(batchId: string): boolean {
    return this.db.prepare(`DELETE FROM batches WHERE id = ?`).run(batchId).changes > 0;
  }
}
