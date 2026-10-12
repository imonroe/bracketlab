import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "@/server/config";
import { openDatabase, type Db } from "@/server/jobs/db";
import { JobStore } from "@/server/jobs/store";

export interface TestEnv {
  dir: string;
  config: AppConfig;
  db: Db;
  store: JobStore;
  clock: { now: number };
  cleanup: () => void;
}

/** Fresh data directory, database and store with a controllable clock. */
export function makeEnv(overrides: Partial<AppConfig> = {}): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bracketlab-test-"));
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    dataDir: dir,
    dbPath: path.join(dir, "test.sqlite"),
    jobsDir: path.join(dir, "jobs"),
    ...overrides,
  };
  const db = openDatabase(config.dbPath);
  const clock = { now: 1_700_000_000_000 };
  const store = new JobStore(db, () => clock.now);
  return {
    dir,
    config,
    db,
    store,
    clock,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function streamOf(...chunks: (string | Buffer)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? Buffer.from(c) : c);
      controller.close();
    },
  });
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
