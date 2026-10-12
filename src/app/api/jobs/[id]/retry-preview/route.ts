import { getContext } from "@/server/context";
import { json } from "@/server/http";
import { authorize, retryPreview, toPublicJob } from "@/server/jobs/service";

export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/retry-preview">) {
  const { id } = await ctx.params;
  const { store, config } = getContext();
  const job = authorize(store, request, id);
  if (job instanceof Response) return job;
  const result = retryPreview(store, job);
  if (result instanceof Response) return result;
  return json(toPublicJob(store, config, result), { status: 202 });
}
