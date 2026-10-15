import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Each job gets a random capability token when it is created. Only its SHA-256 hash is
 * stored. The browser holds the token in an HttpOnly cookie scoped to that job's (or
 * batch's) API path, so downloads work as ordinary links without putting the token in a URL.
 * Non-browser clients may send it as `Authorization: Bearer <token>` instead.
 */

/** What a capability token grants access to; also the API path segment it is scoped to. */
export type Scope = "jobs" | "batches";

const COOKIE_PREFIX: Record<Scope, string> = { jobs: "bl_job_", batches: "bl_batch_" };

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

export function cookieName(id: string, scope: Scope = "jobs"): string {
  return `${COOKIE_PREFIX[scope]}${id}`;
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

/** Extracts the presented token from the Authorization header or the scoped cookie. */
export function presentedToken(request: Request, id: string, scope: Scope = "jobs"): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return readCookie(request.headers.get("cookie"), cookieName(id, scope));
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

export function buildCookie(request: Request, scope: Scope, id: string, token: string, maxAgeMs: number): string {
  const parts = [
    `${cookieName(id, scope)}=${token}`,
    `Path=/api/${scope}/${id}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(scope: Scope, id: string): string {
  return `${cookieName(id, scope)}=; Path=/api/${scope}/${id}; Max-Age=0; HttpOnly; SameSite=Strict`;
}

export function buildJobCookie(request: Request, jobId: string, token: string, maxAgeMs: number): string {
  return buildCookie(request, "jobs", jobId, token, maxAgeMs);
}

export function clearJobCookie(jobId: string): string {
  return clearCookie("jobs", jobId);
}
