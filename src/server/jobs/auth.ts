import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Each job gets a random capability token when it is created. Only its SHA-256 hash is
 * stored. The browser holds the token in an HttpOnly cookie scoped to that job's API
 * path, so downloads work as ordinary links without putting the token in a URL.
 * Non-browser clients may send it as `Authorization: Bearer <token>` instead.
 */

const COOKIE_PREFIX = "bl_job_";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function cookieName(jobId: string): string {
  return `${COOKIE_PREFIX}${jobId}`;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Extracts the presented token for a job from the Authorization header or job cookie. */
export function presentedToken(request: Request, jobId: string): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return readCookie(request.headers.get("cookie"), cookieName(jobId));
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

export function buildJobCookie(request: Request, jobId: string, token: string, maxAgeMs: number): string {
  const parts = [
    `${cookieName(jobId)}=${token}`,
    `Path=/api/jobs/${jobId}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearJobCookie(jobId: string): string {
  return `${cookieName(jobId)}=; Path=/api/jobs/${jobId}; Max-Age=0; HttpOnly; SameSite=Strict`;
}
