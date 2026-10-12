/** Shared JSON response helpers for the route handlers. */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function apiError(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, { status });
}

/**
 * Missing jobs and jobs the caller has no capability for look identical, so the API
 * does not reveal which job IDs exist.
 */
export function notFound(): Response {
  return apiError(404, "not_found", "Job not found.");
}
