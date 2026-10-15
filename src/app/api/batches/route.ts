import { batchDeps } from "@/server/batches/deps";
import { createBatch, toPublicBatch } from "@/server/batches/service";
import { json } from "@/server/http";
import { buildCookie } from "@/server/jobs/auth";

/** Creates an empty batch and hands the browser its capability cookie. */
export async function POST(request: Request) {
  const deps = batchDeps();
  const { batch, token } = createBatch(deps);
  return json(toPublicBatch(deps, batch), {
    status: 201,
    headers: { "set-cookie": buildCookie(request, "batches", batch.id, token, deps.config.retentionMs) },
  });
}
