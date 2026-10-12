import { getContext } from "@/server/context";
import { json } from "@/server/http";
import { clearJobCookie } from "@/server/jobs/auth";
import { authorize, deleteJob, toPublicJob } from "@/server/jobs/service";

export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const { store, config } = getContext();
  const job = authorize(store, request, id);
  if (job instanceof Response) return job;
  return json(toPublicJob(store, config, job));
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const { store, config } = getContext();
  const job = authorize(store, request, id);
  if (job instanceof Response) return job;
  await deleteJob(store, config, job);
  return new Response(null, { status: 204, headers: { "set-cookie": clearJobCookie(id) } });
}
