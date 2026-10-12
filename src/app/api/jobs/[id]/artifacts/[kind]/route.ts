import fs from "node:fs";
import { Readable } from "node:stream";
import { getContext } from "@/server/context";
import { apiError } from "@/server/http";
import { artifactPath, authorize } from "@/server/jobs/service";
import type { ArtifactKind } from "@/server/jobs/store";

const ARTIFACTS: Record<string, { kind: ArtifactKind; type: string; filename: string }> = {
  dng: { kind: "dng", type: "image/x-adobe-dng", filename: "bracketlab-hdr.dng" },
  jpeg: { kind: "jpeg", type: "image/jpeg", filename: "bracketlab-preview.jpg" },
};

/** Streams a finished artifact. `?inline=1` lets the page display the JPEG in place. */
export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[id]/artifacts/[kind]">) {
  const { id, kind } = await ctx.params;
  const { store, config } = getContext();
  const job = authorize(store, request, id);
  if (job instanceof Response) return job;

  const artifact = Object.hasOwn(ARTIFACTS, kind) ? ARTIFACTS[kind] : undefined;
  if (!artifact) return apiError(404, "not_found", "Unknown artifact.");
  const file = artifactPath(config, job, artifact.kind);
  if (!file) return apiError(404, "not_ready", "That file isn't available.");

  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return apiError(404, "not_ready", "That file isn't available.");
  }

  const inline = artifact.kind === "jpeg" && new URL(request.url).searchParams.get("inline") === "1";
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "content-type": artifact.type,
      "content-length": String(size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
