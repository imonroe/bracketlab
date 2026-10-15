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
    batchesDir: path.join(dir, "batches"),
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

/**
 * Installs a stand-in for ExifTool that treats each file's contents as its ExifTool JSON
 * record, so a test controls exactly what each upload reports. Non-JSON contents behave
 * like a file ExifTool can't read. Turns metadata checks on (native engine) until the
 * returned function restores the environment; reset config and context after either.
 */
export function installStubExiftool(dir: string): () => void {
  const stub = path.join(dir, "exiftool-stub");
  fs.writeFileSync(
    stub,
    `#!/bin/bash
for last; do :; done
if body="$(cat "$last")" && printf '%s' "$body" | head -c1 | grep -q '{'; then
  echo "[$body]"
else
  echo "[{\\"SourceFile\\": \\"$last\\"}]"; exit 1
fi
`,
  );
  fs.chmodSync(stub, 0o755);
  process.env.BRACKETLAB_ENGINE = "native";
  process.env.BRACKETLAB_EXIFTOOL = stub;
  return () => {
    delete process.env.BRACKETLAB_ENGINE;
    delete process.env.BRACKETLAB_EXIFTOOL;
  };
}

/** An ExifTool record for an a6100 ARW, as the stub returns it. */
export function arwRecord(exposureTime: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    FileType: "ARW",
    Make: "SONY",
    Model: "ILCE-6100",
    ISO: 100,
    FNumber: 8,
    FocalLength: 16,
    ExposureTime: exposureTime,
    ...extra,
  });
}
