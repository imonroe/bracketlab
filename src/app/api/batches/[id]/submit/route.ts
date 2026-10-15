import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, submitBatch } from "@/server/batches/service";
import { apiError, json } from "@/server/http";

/** Body: { "include": ["<set key>", ...] }, the reviewed sets to merge. */
export async function POST(request: Request, ctx: RouteContext<"/api/batches/[id]/submit">) {
  const { id } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  let body: { include?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Expected a JSON body.");
  }
  const result = await submitBatch(deps, batch, body?.include);
  if (result instanceof Response) return result;
  return json(result, { status: 202 });
}
