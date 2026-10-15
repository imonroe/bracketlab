import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, deleteBatch, toPublicBatch } from "@/server/batches/service";
import { json } from "@/server/http";
import { clearCookie } from "@/server/jobs/auth";

export async function GET(request: Request, ctx: RouteContext<"/api/batches/[id]">) {
  const { id } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  return json(toPublicBatch(deps, batch));
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/batches/[id]">) {
  const { id } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  await deleteBatch(deps, batch);
  return new Response(null, { status: 204, headers: { "set-cookie": clearCookie("batches", id) } });
}
