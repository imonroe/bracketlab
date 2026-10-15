import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, removeBatchFile } from "@/server/batches/service";

export async function DELETE(request: Request, ctx: RouteContext<"/api/batches/[id]/files/[fileId]">) {
  const { id, fileId } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  return (await removeBatchFile(deps, batch, fileId)) ?? new Response(null, { status: 204 });
}
