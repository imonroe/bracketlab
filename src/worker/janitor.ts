import fsp from "node:fs/promises";
import type { AppConfig } from "@/server/config";
import type { JobStore } from "@/server/jobs/store";
import { removeTree } from "@/server/storage/files";
import { JobPaths, isJobId } from "@/server/storage/paths";

/** How long an expired job's row lingers so a returning browser sees "expired". */
const EXPIRED_ROW_TTL_MS = 24 * 60 * 60 * 1000;

export interface JanitorReport {
  expired: string[];
  purged: string[];
  orphans: string[];
}

/**
 * Enforces retention: expires jobs past their deadline (and abandoned uploads), deletes
 * their files, drops old expired rows, and removes job folders with no database row.
 */
export async function runJanitor(store: JobStore, config: AppConfig): Promise<JanitorReport> {
  const expired: string[] = [];
  for (const job of store.listExpirable(config.uploadIdleMs)) {
    if (store.transition(job.id, job.state, "expired", { errorCode: null, errorMessage: null })) {
      await removeTree(new JobPaths(config.jobsDir, job.id).root);
      store.setArtifact(job.id, "dng", null);
      store.setArtifact(job.id, "jpeg", null);
      expired.push(job.id);
    }
  }

  const purged = store.purgeExpired(EXPIRED_ROW_TTL_MS);

  const orphans: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(config.jobsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (isJobId(entry) && !store.get(entry)) {
      await removeTree(new JobPaths(config.jobsDir, entry).root);
      orphans.push(entry);
    }
  }

  return { expired, purged, orphans };
}
