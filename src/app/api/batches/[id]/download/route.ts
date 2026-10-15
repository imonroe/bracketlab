import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, batchZip } from "@/server/batches/service";

/** One ZIP of every finished set: DNGs at the top, JPEG previews in previews/. */
export async function GET(request: Request, ctx: RouteContext<"/api/batches/[id]/download">) {
  const { id } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  return batchZip(deps, batch);
}
