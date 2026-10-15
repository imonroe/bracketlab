import { BatchStore } from "./batches/store";
import { getConfig, type AppConfig } from "./config";
import { openDatabase, type Db } from "./jobs/db";
import { JobStore } from "./jobs/store";

export interface ServerContext {
  config: AppConfig;
  db: Db;
  store: JobStore;
  batches: BatchStore;
}

// Kept on globalThis so Next.js dev-mode module reloads reuse one connection.
const globalForContext = globalThis as typeof globalThis & { __bracketlab?: ServerContext };

export function getContext(): ServerContext {
  if (!globalForContext.__bracketlab) {
    const config = getConfig();
    const db = openDatabase(config.dbPath);
    globalForContext.__bracketlab = { config, db, store: new JobStore(db), batches: new BatchStore(db) };
  }
  return globalForContext.__bracketlab;
}

/** Test hook: close and forget the shared context. */
export function resetContext(): void {
  globalForContext.__bracketlab?.db.close();
  globalForContext.__bracketlab = undefined;
}
