"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicBatch, PublicBatchJob } from "@/server/batches/service";
import { formatBytes, formatElapsed, formatEv, formatExposure, readError, sendFile } from "../client-utils";
import styles from "../page.module.css";

const STORAGE_KEY = "bracketlab.batchId";
const POLL_MS = 2000;
/** Parallel uploads. More doesn't help a local network and hurts progress feedback. */
const UPLOAD_CONCURRENCY = 3;
const ACTIVE = new Set(["queued", "merging", "rendering_preview"]);

const JOB_LABELS: Record<PublicBatchJob["state"], string> = {
  uploading: "Waiting",
  validating: "Checking",
  queued: "Queued",
  merging: "Merging",
  rendering_preview: "Rendering preview",
  complete: "Done",
  raw_ready_preview_failed: "DNG ready; preview failed",
  failed: "Failed",
  canceled: "Canceled",
  expired: "Expired",
};

interface Upload {
  key: number;
  file: File;
  loaded: number;
  status: "waiting" | "uploading" | "done" | "error";
  error?: string;
}

export function BatchApp() {
  const [batch, setBatch] = useState<PublicBatch | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const batchIdRef = useRef<string | null>(null);
  const creatingRef = useRef<Promise<string | null> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextKey = useRef(0);
  const running = useRef(0);
  const queue = useRef<Upload[]>([]);

  const adopt = useCallback((next: PublicBatch | null) => {
    setBatch(next);
    batchIdRef.current = next?.id ?? null;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next.id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    const id = batchIdRef.current;
    if (!id) return;
    const response = await fetch(`/api/batches/${id}`, { cache: "no-store" });
    if (response.status === 404) {
      adopt(null);
      return;
    }
    if (response.ok) setBatch(await response.json());
  }, [adopt]);

  // Restore the batch this browser was working on.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (!stored) return;
    batchIdRef.current = stored;
    void refresh();
  }, [refresh]);

  const uploading = uploads.some((u) => u.status === "waiting" || u.status === "uploading");
  const merging = batch?.jobs.some((j) => ACTIVE.has(j.state)) ?? false;
  useEffect(() => {
    if (!merging) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [merging, refresh]);

  // Concurrent first uploads must share one batch (see the single-bracket page).
  const ensureBatch = useCallback((): Promise<string | null> => {
    if (batchIdRef.current) return Promise.resolve(batchIdRef.current);
    creatingRef.current ??= (async () => {
      try {
        const response = await fetch("/api/batches", { method: "POST" });
        if (!response.ok) {
          setNotice(await readError(response));
          return null;
        }
        const created: PublicBatch = await response.json();
        adopt(created);
        return created.id;
      } finally {
        creatingRef.current = null;
      }
    })();
    return creatingRef.current;
  }, [adopt]);

  const update = (key: number, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const pump = useCallback(async () => {
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const item = queue.current.shift()!;
      running.current += 1;
      void (async () => {
        try {
          const id = await ensureBatch();
          if (!id) {
            update(item.key, { status: "error", error: "Couldn't start a batch." });
            return;
          }
          update(item.key, { status: "uploading" });
          const result = await sendFile("POST", `/api/batches/${id}/files`, item.file, (loaded) =>
            update(item.key, { loaded }),
          );
          update(item.key, result.ok ? { status: "done", loaded: item.file.size } : { status: "error", error: result.message });
        } finally {
          running.current -= 1;
          void pump();
          if (running.current === 0 && queue.current.length === 0) void refresh();
        }
      })();
    }
  }, [ensureBatch, refresh]);

  const addFiles = (files: FileList | File[]) => {
    setNotice(null);
    const added = Array.from(files).map((file) => ({ key: nextKey.current++, file, loaded: 0, status: "waiting" as const }));
    if (added.length === 0) return;
    queue.current.push(...added);
    setUploads((list) => [...list, ...added]);
    void pump();
  };

  const removeFile = async (fileId: string) => {
    if (!batch) return;
    await fetch(`/api/batches/${batch.id}/files/${fileId}`, { method: "DELETE" });
    await refresh();
  };

  const mergeAll = async () => {
    if (!batch?.review) return;
    const include = batch.review.sets.map((s) => s.key).filter((k) => !excluded.has(k));
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/batches/${batch.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include }),
      });
      if (!response.ok) setNotice(await readError(response));
      else {
        setUploads([]);
        setBatch(await response.json());
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (jobId: string) => {
    if (!batch) return;
    const response = await fetch(`/api/batches/${batch.id}/sets/${jobId}/retry`, { method: "POST" });
    if (!response.ok) setNotice(await readError(response));
    await refresh();
  };

  const deleteBatch = async () => {
    if (!batch) return;
    if (!window.confirm("Delete this batch and all of its files and results?")) return;
    setBusy(true);
    try {
      await fetch(`/api/batches/${batch.id}`, { method: "DELETE" });
      queue.current = [];
      setUploads([]);
      setExcluded(new Set());
      adopt(null);
      setNotice("Deleted. All files for that batch were removed.");
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    const done = batch?.jobs.some((j) => j.artifacts.dng) ?? false;
    if (done && !window.confirm("Start a new batch? This page will stop showing the current results. Download them first if you need them.")) {
      return;
    }
    setUploads([]);
    setExcluded(new Set());
    adopt(null);
  };

  const open = !batch || batch.state === "open";
  const sets = batch?.review?.sets ?? [];
  const unplaced = batch?.review?.unplaced ?? [];
  const fileName = (id: string) => batch?.files.find((f) => f.id === id)?.name ?? "?";
  const fileExposure = (id: string) => batch?.files.find((f) => f.id === id)?.exposure;
  const included = sets.filter((s) => !excluded.has(s.key)).length;
  const failedUploads = uploads.filter((u) => u.status === "error");
  const uploadedBytes = uploads.reduce((sum, u) => sum + u.loaded, 0);
  const totalBytes = uploads.reduce((sum, u) => sum + u.file.size, 0);
  const doneUploads = uploads.filter((u) => u.status === "done").length;
  const jobs = batch?.jobs ?? [];
  const finished = jobs.filter((j) => j.finished).length;
  const activeJobs = jobs.filter((j) => ACTIVE.has(j.state)).length;
  const base = batch ? `/api/batches/${batch.id}` : "";

  return (
    <section className={styles.app} aria-labelledby="batch-heading">
      <h2 id="batch-heading">Your shoot</h2>

      {open && (
        <div
          className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <p>Drop all of the shoot&apos;s RAW files here.</p>
          <p>
            <input
              ref={inputRef}
              id="batch-files"
              className={styles.visuallyHidden}
              type="file"
              multiple
              accept=".arw,.ARW"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" className={styles.secondary} onClick={() => inputRef.current?.click()}>
              Choose files
            </button>
          </p>
          {batch && (
            <p className={styles.muted}>
              Up to {batch.limits.maxBatchFiles} files and {formatBytes(batch.limits.maxBatchBytes)} per batch.
            </p>
          )}
        </div>
      )}

      {uploads.length > 0 && open && (
        <div className={styles.status} role="status" aria-live="polite">
          <p>
            {uploading ? (
              <>
                Uploading {doneUploads} of {uploads.length} files · {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)}
              </>
            ) : (
              <>Uploaded {doneUploads} of {uploads.length} files.</>
            )}
          </p>
          {uploading && (
            <progress className={styles.progress} max={totalBytes || 1} value={uploadedBytes} aria-label="Upload progress" />
          )}
          {failedUploads.map((u) => (
            <p key={u.key} className={styles.error}>
              {u.file.name}: {u.error}
            </p>
          ))}
        </div>
      )}

      {notice && (
        <p className={styles.error} role="alert">
          {notice}
        </p>
      )}

      {open && batch && !uploading && (sets.length > 0 || unplaced.length > 0) && (
        <>
          <h3 className={styles.subheading}>
            {sets.length} {sets.length === 1 ? "set" : "sets"} found
          </h3>
          <ol className={styles.sets}>
            {sets.map((set, i) => {
              const checked = !excluded.has(set.key);
              const first = fileExposure(set.fileIds[0]);
              return (
                <li key={set.key} className={`${styles.setCard} ${checked ? "" : styles.setExcluded}`}>
                  <label className={styles.setHeader}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(set.key)) next.delete(set.key);
                          else next.add(set.key);
                          return next;
                        })
                      }
                    />
                    <strong>Set {i + 1}</strong>
                    <span className={styles.fileName}>{set.label}</span>
                  </label>
                  <p className={styles.exposure}>
                    {set.order.map((o) => `${o.shutter ?? "?"} (${formatEv(o.evOffset)})`).join(" · ")}
                    {first && ` · ${formatExposure({ iso: first.iso, fNumber: first.fNumber, focalLength: first.focalLength })}`}
                    {` · shot over ${set.spanSeconds}s`}
                  </p>
                  <p className={styles.muted}>{set.fileIds.map(fileName).join(", ")}</p>
                  {set.warnings.map((w) => (
                    <p key={w.code} className={styles.warning}>
                      {w.message}
                    </p>
                  ))}
                </li>
              );
            })}
          </ol>

          {unplaced.length > 0 && (
            <>
              <h3 className={styles.subheading}>Not in a set ({unplaced.length})</h3>
              <ul className={styles.unplaced}>
                {unplaced.map((u) => (
                  <li key={u.fileId}>
                    <span>
                      <span className={styles.fileName}>{fileName(u.fileId)}</span>
                      <span className={styles.muted}> {u.reason}</span>
                    </span>
                    <button type="button" className={styles.secondary} onClick={() => removeFile(u.fileId)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy || included === 0} onClick={mergeAll}>
              Merge {included} {included === 1 ? "set" : "sets"}
            </button>
          </div>
        </>
      )}

      {batch?.state === "submitted" && (
        <>
          <div className={styles.status} role="status" aria-live="polite">
            <p>
              <strong>
                {finished} of {jobs.length} {jobs.length === 1 ? "set" : "sets"} merged
              </strong>
              {activeJobs > 0 && ` · ${activeJobs} still working`}
            </p>
            {activeJobs > 0 && <progress className={styles.progress} max={jobs.length} value={jobs.length - activeJobs} aria-label="Merge progress" />}
          </div>

          <div className={styles.actions}>
            {finished > 0 && (
              <a className={styles.primary} href={`${base}/download`} download>
                {activeJobs === 0 && finished === jobs.length ? "Download all" : `Download ${finished} finished`} (.zip)
              </a>
            )}
          </div>

          <ol className={styles.sets}>
            {jobs.map((job) => (
              <li key={job.id} className={styles.setCard}>
                <div className={styles.setResult}>
                  {job.artifacts.jpeg ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated, uncached stream
                    <img
                      className={styles.thumb}
                      src={`${base}/sets/${job.id}/jpeg?inline=1`}
                      alt={`Preview of ${job.label}`}
                      loading="lazy"
                    />
                  ) : (
                    <span className={styles.thumbPlaceholder} aria-hidden="true" />
                  )}
                  <span className={styles.setBody}>
                    <strong className={styles.fileName}>{job.label}</strong>
                    <span className={styles.muted}>
                      {JOB_LABELS[job.state]}
                      {ACTIVE.has(job.state) && job.state !== "queued" && ` · ${formatElapsed(now - job.stateChangedAt)}`}
                    </span>
                    {job.error && <span className={styles.error}>{job.error.message}</span>}
                    <span className={styles.actions}>
                      {job.artifacts.dng && (
                        <a className={styles.secondary} href={`${base}/sets/${job.id}/dng`} download>
                          DNG · {formatBytes(job.artifacts.dng.bytes)}
                        </a>
                      )}
                      {(job.state === "raw_ready_preview_failed" || (job.state === "failed" && job.error?.retryable)) && (
                        <button type="button" className={styles.secondary} onClick={() => retry(job.id)}>
                          Retry
                        </button>
                      )}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {batch && batch.state === "expired" && <p className={styles.muted}>This batch has expired and its files were deleted.</p>}

      {batch && (
        <div className={styles.footer}>
          <p className={styles.muted}>Files expire {new Date(batch.expiresAt).toLocaleString()}.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={busy} onClick={deleteBatch}>
              Delete batch
            </button>
            {batch.state !== "open" && (
              <button type="button" className={styles.secondary} onClick={startOver}>
                Start a new batch
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
