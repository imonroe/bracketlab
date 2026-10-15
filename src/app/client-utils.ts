import type { PublicInput } from "@/server/jobs/service";

/** Helpers shared by the single-bracket and batch pages. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatExposure(e: NonNullable<PublicInput["exposure"]>): string {
  return [
    e.shutter,
    e.iso !== undefined && `ISO ${e.iso}`,
    e.fNumber !== undefined && `f/${e.fNumber}`,
    e.focalLength !== undefined && `${e.focalLength}mm`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatEv(ev: number): string {
  return ev === 0 ? "0 EV" : `+${ev} EV`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body?.error?.message ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

export type UploadResult = { ok: true; body: unknown } | { ok: false; message: string };

/** Sends a file with upload progress. fetch() has no upload progress events, so this uses XHR. */
export function sendFile(
  method: "PUT" | "POST",
  url: string,
  file: File,
  onProgress: (loaded: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true, body });
      const message = (body as { error?: { message?: string } } | null)?.error?.message ?? `Upload failed (${xhr.status}).`;
      resolve({ ok: false, message });
    };
    xhr.onerror = () => resolve({ ok: false, message: "Upload interrupted. Try again." });
    xhr.send(file);
  });
}
