import { getContext } from "@/server/context";
import { apiError, json } from "@/server/http";
import { authorize, uploadInput } from "@/server/jobs/service";
import { parseSlot } from "@/server/storage/paths";

/** Streams one RAW file into slot 0, 1 or 2. Uploading to a filled slot replaces it. */
export async function PUT(request: Request, ctx: RouteContext<"/api/jobs/[id]/inputs/[slot]">) {
  const { id, slot: rawSlot } = await ctx.params;
  const { store, config } = getContext();
  const job = authorize(store, request, id);
  if (job instanceof Response) return job;
  const slot = parseSlot(rawSlot);
  if (slot === undefined) return apiError(404, "not_found", "Unknown input slot.");

  const result = await uploadInput(store, config, job, slot, request);
  if (result instanceof Response) return result;
  return json({ slot: result.slot, name: result.originalName, bytes: result.bytes });
}
