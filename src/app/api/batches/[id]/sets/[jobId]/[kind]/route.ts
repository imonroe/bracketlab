import fs from "node:fs";
import { batchDeps } from "@/server/batches/deps";
import { authorizeBatch, batchArtifactPath, fileStream } from "@/server/batches/service";
import { apiError } from "@/server/http";

const TYPES = { dng: "image/x-adobe-dng", jpeg: "image/jpeg" } as const;
const EXTENSIONS = { dng: "dng", jpeg: "jpg" } as const;

/** One set's DNG or JPEG. `?inline=1` lets the page show the JPEG in place. */
export async function GET(request: Request, ctx: RouteContext<"/api/batches/[id]/sets/[jobId]/[kind]">) {
  const { id, jobId, kind } = await ctx.params;
  const deps = batchDeps();
  const batch = authorizeBatch(deps, request, id);
  if (batch instanceof Response) return batch;
  if (kind !== "dng" && kind !== "jpeg") return apiError(404, "not_found", "Unknown artifact.");

  const found = batchArtifactPath(deps, batch, jobId, kind);
  if (found instanceof Response) return found;
  let size: number;
  try {
    size = (await fs.promises.stat(found.file)).size;
  } catch {
    return apiError(404, "not_ready", "That file isn't available.");
  }
  const inline = kind === "jpeg" && new URL(request.url).searchParams.get("inline") === "1";
  return new Response(fileStream(found.file), {
    headers: {
      "content-type": TYPES[kind],
      "content-length": String(size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${found.label}.${EXTENSIONS[kind]}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
