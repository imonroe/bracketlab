import fsp from "node:fs/promises";
import type { BatchStore } from "@/server/batches/store";
import type { AppConfig } from "@/server/config";
import type { JobStore } from "@/server/jobs/store";
import { removeTree } from "@/server/storage/files";
import { BatchPaths, JobPaths, isJobId } from "@/server/storage/paths";

/** How long an expired job's row lingers so a returning browser sees "expired". */
const EXPIRED_ROW_TTL_MS = 24 * 60 * 60 * 1000;

export interface JanitorReport {
  expired: string[];
  purged: string[];
  orphans: string[];
  expiredBatches: string[];
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Enforces retention: expires jobs past their deadline (and abandoned uploads), deletes
 * their files, drops old expired rows, and removes job folders with no database row.
 */
export async function runJanitor(store: JobStore, config: AppConfig, batches?: BatchStore): Promise<JanitorReport> {
  // Batches first: expiring one releases its files, and its jobs expire just below.
  const expiredBatches: string[] = [];
  if (batches) {
    for (const batch of batches.listExpirable(config.uploadIdleMs)) {
      if (batches.expire(batch.id)) {
        await removeTree(new BatchPaths(config.batchesDir, batch.id).root);
        expiredBatches.push(batch.id);
      }
    }
  }

  const expired: string[] = [];
  for (const job of store.listExpirable(config.uploadIdleMs)) {
    if (store.transition(job.id, job.state, "expired", { errorCode: null, errorMessage: null })) {
      await removeTree(new JobPaths(config.jobsDir, job.id).root);
      store.setArtifact(job.id, "dng", null);
      store.setArtifact(job.id, "jpeg", null);
      expired.push(job.id);
    }
  }

  const purged = [...store.purgeExpired(EXPIRED_ROW_TTL_MS), ...(batches?.purgeExpired(EXPIRED_ROW_TTL_MS) ?? [])];

  const orphans: string[] = [];
  for (const entry of await listDir(config.jobsDir)) {
    if (isJobId(entry) && !store.get(entry)) {
      await removeTree(new JobPaths(config.jobsDir, entry).root);
      orphans.push(entry);
    }
  }
  if (batches) {
    for (const entry of await listDir(config.batchesDir)) {
      const batch = isJobId(entry) ? batches.get(entry) : undefined;
      // A batch's folder only matters while it is open; submit moves the files out.
      if (isJobId(entry) && (!batch || batch.state !== "open")) {
        await removeTree(new BatchPaths(config.batchesDir, entry).root);
        orphans.push(entry);
      }
    }
  }

  return { expired, purged, orphans, expiredBatches };
}
