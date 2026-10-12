import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { JOB_STATES } from "./states";

export type Db = Database.Database;

const stateList = JOB_STATES.map((s) => `'${s}'`).join(", ");

/**
 * Ordered schema migrations. Each entry runs once, inside a transaction, and bumps
 * PRAGMA user_version. Append new entries; never edit an applied one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id                TEXT PRIMARY KEY,
    token_hash        TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN (${stateList})),
    next_stage        TEXT CHECK (next_stage IN ('merge', 'preview')),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    state_changed_at  INTEGER NOT NULL,
    queued_at         INTEGER,
    expires_at        INTEGER NOT NULL,
    error_code        TEXT,
    error_message     TEXT,
    retryable         INTEGER NOT NULL DEFAULT 0,
    dng_bytes         INTEGER,
    jpeg_bytes        INTEGER,
    manifest          TEXT
  );
  CREATE INDEX jobs_state_queued ON jobs (state, queued_at);
  CREATE INDEX jobs_expires ON jobs (expires_at);

  CREATE TABLE job_inputs (
    job_id         TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    slot           INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
    original_name  TEXT NOT NULL,
    bytes          INTEGER NOT NULL,
    sha256         TEXT NOT NULL,
    uploaded_at    INTEGER NOT NULL,
    PRIMARY KEY (job_id, slot)
  );

  CREATE TABLE worker_heartbeat (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    pid      INTEGER NOT NULL,
    beat_at  INTEGER NOT NULL
  );
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets the web process read while the worker writes.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}
