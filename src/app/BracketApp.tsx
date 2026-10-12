"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicInput, PublicJob } from "@/server/jobs/service";
import styles from "./page.module.css";

const STORAGE_KEY = "bracketlab.jobId";
const POLL_MS = 2000;
const SLOTS = [0, 1, 2] as const;
const POLLING_STATES = new Set(["validating", "queued", "merging", "rendering_preview"]);

type SlotStatus = "empty" | "uploading" | "done" | "error";

interface SlotView {
  status: SlotStatus;
  name?: string;
  bytes?: number;
  loaded?: number;
  error?: string;
}

const EMPTY_SLOTS: SlotView[] = SLOTS.map(() => ({ status: "empty" }));

const STATE_LABELS: Record<PublicJob["state"], string> = {
  uploading: "Waiting for files",
  validating: "Checking files",
  queued: "Queued",
  merging: "Merging exposures",
  rendering_preview: "Rendering preview",
  complete: "Done",
  raw_ready_preview_failed: "HDR RAW ready; preview failed",
  failed: "Failed",
  canceled: "Canceled",
  expired: "Expired",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExposure(e: NonNullable<PublicInput["exposure"]>): string {
  return [
    e.shutter,
    e.iso !== undefined && `ISO ${e.iso}`,
    e.fNumber !== undefined && `f/${e.fNumber}`,
    e.focalLength !== undefined && `${e.focalLength}mm`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatEv(ev: number): string {
  return ev === 0 ? "0 EV" : `+${ev} EV`;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body?.error?.message ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

function slotsFromJob(job: PublicJob): SlotView[] {
  return SLOTS.map((slot) => {
    const input = job.inputs.find((i) => i.slot === slot);
    return input ? { status: "done", name: input.name, bytes: input.bytes } : { status: "empty" };
  });
}

/** PUT with upload progress. fetch() has no upload progress events, so this uses XHR. */
function uploadFile(
  jobId: string,
  slot: number,
  file: File,
  onProgress: (loaded: number) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/jobs/${jobId}/inputs/${slot}`);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let message = `Upload failed (${xhr.status}).`;
      try {
        message = JSON.parse(xhr.responseText)?.error?.message ?? message;
      } catch {}
      resolve({ ok: false, message });
    };
    xhr.onerror = () => resolve({ ok: false, message: "Upload interrupted. Try again." });
    xhr.send(file);
  });
}

export function BracketApp() {
  const [job, setJob] = useState<PublicJob | null>(null);
  const [slots, setSlots] = useState<SlotView[]>(EMPTY_SLOTS);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const adoptJob = useCallback((next: PublicJob | null) => {
    setJob(next);
    jobIdRef.current = next?.id ?? null;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next.id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
    if (response.status === 404) {
      adoptJob(null);
      setSlots(EMPTY_SLOTS);
      return;
    }
    if (response.ok) setJob(await response.json());
  }, [adoptJob]);

  // Restore the job this browser was working on.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (!stored) return;
    jobIdRef.current = stored;
    fetch(`/api/jobs/${stored}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        adoptJob(null);
        return;
      }
      const restored: PublicJob = await response.json();
      setJob(restored);
      setSlots(slotsFromJob(restored));
    });
  }, [adoptJob]);

  const polling = job !== null && POLLING_STATES.has(job.state);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  // Several uploads can start in the same tick (a multi-file drop). They must share one
  // job, so concurrent callers await the same creation request instead of each making one.
  const creatingJobRef = useRef<Promise<string | null> | null>(null);
  const ensureJob = useCallback((): Promise<string | null> => {
    if (jobIdRef.current) return Promise.resolve(jobIdRef.current);
    creatingJobRef.current ??= (async () => {
      try {
        const response = await fetch("/api/jobs", { method: "POST" });
        if (!response.ok) {
          setNotice(await readError(response));
          return null;
        }
        const created: PublicJob = await response.json();
        adoptJob(created);
        return created.id;
      } finally {
        creatingJobRef.current = null;
      }
    })();
    return creatingJobRef.current;
  }, [adoptJob]);

  const setSlot = (slot: number, view: SlotView) =>
    setSlots((current) => current.map((s, i) => (i === slot ? view : s)));

  const uploadToSlot = useCallback(
    async (slot: number, file: File) => {
      setNotice(null);
      const id = await ensureJob();
      if (!id) return;
      setSlot(slot, { status: "uploading", name: file.name, bytes: file.size, loaded: 0 });
      const result = await uploadFile(id, slot, file, (loaded) =>
        setSlot(slot, { status: "uploading", name: file.name, bytes: file.size, loaded }),
      );
      setSlot(
        slot,
        result.ok
          ? { status: "done", name: file.name, bytes: file.size }
          : { status: "error", name: file.name, bytes: file.size, error: result.message },
      );
      await refresh();
    },
    [ensureJob, refresh],
  );

  const acceptFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    const open = SLOTS.filter((s) => slots[s].status === "empty" || slots[s].status === "error");
    if (list.length > open.length) {
      setNotice(`Only ${open.length} slot${open.length === 1 ? "" : "s"} free. Replace a file to change it.`);
    }
    list.slice(0, open.length).forEach((file, i) => void uploadToSlot(open[i], file));
  };

  const act = async (path: string, method = "POST") => {
    if (!job) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}${path}`, { method });
      if (!response.ok) setNotice(await readError(response));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const deleteNow = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      adoptJob(null);
      setSlots(EMPTY_SLOTS);
      setNotice("Deleted. All files for that merge were removed.");
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    if (job && (job.artifacts.dng || job.artifacts.jpeg)) {
      const ok = window.confirm(
        "Start a new merge? This page will stop showing the current result. It stays on the server until it expires, so download anything you need first.",
      );
      if (!ok) return;
    }
    adoptJob(null);
    setSlots(EMPTY_SLOTS);
    setNotice(null);
  };

  const editable = !job || job.state === "uploading";
  const allUploaded = slots.every((s) => s.status === "done");
  const anyUploading = slots.some((s) => s.status === "uploading");
  const cancelable = job !== null && POLLING_STATES.has(job.state);
  const finished = job !== null && !editable && !cancelable;
  const artifactUrl = (kind: "dng" | "jpeg") => (job ? `/api/jobs/${job.id}/artifacts/${kind}` : "#");
  const bracketOrder = job?.bracket.order ?? null;
  // Per-file problems already show next to their file; list only whole-bracket ones here.
  const perFile = new Set(job?.inputs.flatMap((i) => i.issues.map((x) => x.message)) ?? []);
  const bracketErrors = job?.bracket.errors.filter((e) => !perFile.has(e.message)) ?? [];

  return (
    <section className={styles.app} aria-labelledby="bracket-heading">
      <h2 id="bracket-heading">Your bracket</h2>

      {editable && (
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
            acceptFiles(e.dataTransfer.files);
          }}
        >
          <p>Drop three RAW files here, or choose each file below.</p>
          {job && (
            <p className={styles.muted}>
              Limits: {formatBytes(job.limits.maxFileBytes)} per file,{" "}
              {formatBytes(job.limits.maxJobBytes)} total.
            </p>
          )}
        </div>
      )}

      <ol className={styles.slots}>
        {SLOTS.map((slot) => {
          const view = slots[slot];
          const serverInput = job?.inputs.find((i) => i.slot === slot);
          const inputId = `slot-${slot}`;
          return (
            <li key={slot} className={styles.slot}>
              <span className={styles.slotLabel}>File {slot + 1}</span>
              <span className={styles.slotBody}>
                {view.name ? (
                  <>
                    <span className={styles.fileName}>{view.name}</span>
                    {view.bytes !== undefined && (
                      <span className={styles.muted}> · {formatBytes(view.bytes)}</span>
                    )}
                  </>
                ) : (
                  <span className={styles.muted}>No file yet</span>
                )}
                {view.status === "uploading" && view.bytes ? (
                  <progress
                    className={styles.progress}
                    max={view.bytes}
                    value={view.loaded ?? 0}
                    aria-label={`Uploading file ${slot + 1}`}
                  />
                ) : null}
                {view.status === "error" && (
                  <span className={styles.error} role="alert">
                    {view.error}
                  </span>
                )}
                {view.status === "done" && serverInput?.exposure && (
                  <span className={styles.exposure}>{formatExposure(serverInput.exposure)}</span>
                )}
                {view.status === "done" &&
                  serverInput?.issues.map((issue) => (
                    <span key={issue.code} className={`${styles.error} ${styles.issue}`}>
                      {issue.message}
                    </span>
                  ))}
              </span>
              {editable && (
                <>
                  <input
                    id={inputId}
                    ref={(el) => {
                      inputRefs.current[slot] = el;
                    }}
                    className={styles.visuallyHidden}
                    type="file"
                    accept=".arw,.ARW,.dng,.DNG"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadToSlot(slot, file);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={view.status === "uploading"}
                    onClick={() => inputRefs.current[slot]?.click()}
                  >
                    {view.status === "empty" ? "Choose file" : "Replace"}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {editable && job && !anyUploading && (bracketOrder || bracketErrors.length > 0 || job.bracket.warnings.length > 0) && (
        <div className={styles.bracket} aria-live="polite">
          {bracketOrder && (
            <p>
              <strong>Bracket looks good.</strong> Darkest to brightest:{" "}
              {bracketOrder
                .map(({ slot, evOffset }) => {
                  const input = job.inputs.find((i) => i.slot === slot);
                  return `File ${slot + 1} (${input?.exposure?.shutter ?? "?"}, ${formatEv(evOffset)})`;
                })
                .join(", ")}
              .
            </p>
          )}
          {bracketErrors.map((e) => (
            <p key={e.code} className={styles.error}>
              {e.message}
            </p>
          ))}
          {job.bracket.warnings.map((w) => (
            <p key={w.code} className={styles.warning}>
              {w.message}
            </p>
          ))}
        </div>
      )}

      <div className={styles.status} role="status" aria-live="polite">
        {/* A rejected start reports the same message the job now carries; show it once. */}
        {notice && notice !== job?.error?.message && <p>{notice}</p>}
        {job && job.state !== "uploading" && (
          <p>
            <strong>{STATE_LABELS[job.state]}</strong>
            {job.queuePosition !== null && ` · position ${job.queuePosition} in queue`}
            {polling && ` · ${formatElapsed(now - job.stateChangedAt)} in this step`}
          </p>
        )}
        {job?.error && <p className={styles.error}>{job.error.message}</p>}
      </div>

      <div className={styles.actions}>
        {editable && (
          <button
            type="button"
            className={styles.primary}
            disabled={!allUploaded || anyUploading || busy || !job?.bracket.ready}
            onClick={() => act("/start")}
          >
            Merge exposures
          </button>
        )}
        {cancelable && (
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => act("/cancel")}>
            Cancel
          </button>
        )}
        {job?.state === "raw_ready_preview_failed" && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => act("/retry-preview")}>
            Retry preview
          </button>
        )}
        {job?.state === "failed" && job.error?.retryable && (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => act("/start")}>
            Retry
          </button>
        )}
      </div>

      {job && (job.artifacts.dng || job.artifacts.jpeg) && (
        <div className={styles.result}>
          {job.artifacts.jpeg && (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated, uncached stream
            <img
              className={styles.preview}
              src={`${artifactUrl("jpeg")}?inline=1`}
              alt="Tone-mapped preview of the merged HDR image"
            />
          )}
          <div className={styles.actions}>
            {job.artifacts.dng && (
              <a className={styles.primary} href={artifactUrl("dng")} download>
                Download HDR RAW (.dng) · {formatBytes(job.artifacts.dng.bytes)}
              </a>
            )}
            {job.artifacts.jpeg && (
              <a className={styles.secondary} href={artifactUrl("jpeg")} download>
                Download JPEG preview (.jpg)
              </a>
            )}
          </div>
          <p className={styles.muted}>
            The preview is one interpretation. Exposure and colour remain adjustable when you open
            the DNG in darktable or another RAW editor.
          </p>
        </div>
      )}

      {job && (
        <div className={styles.footer}>
          <p className={styles.muted}>
            Files expire {new Date(job.expiresAt).toLocaleString()}.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={busy} onClick={deleteNow}>
              Delete now
            </button>
            {finished && (
              <button type="button" className={styles.secondary} onClick={startOver}>
                Start a new merge
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
