import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, retryBatchJob } from "@/server/batches/service";
import { json } from "@/server/http";

export async function POST(request: Request, ctx: RouteContext<"/api/batches/[id]/sets/[jobId]/retry">) {
  const { id, jobId } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  const result = retryBatchJob(deps, batch, jobId);
  if (result instanceof Response) return result;
  return json(result, { status: 202 });
}
