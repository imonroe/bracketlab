import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, uploadBatchFile } from "@/server/batches/service";
import { json } from "@/server/http";

/** Streams one RAW file into the batch. The X-Filename header carries its display name. */
export async function POST(request: Request, ctx: RouteContext<"/api/batches/[id]/files">) {
  const { id } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  const result = await uploadBatchFile(deps, batch, request);
  if (result instanceof Response) return result;
  return json(result, { status: 201 });
}
