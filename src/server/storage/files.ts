import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export class TooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Upload exceeds the ${limitBytes}-byte limit`);
    this.name = "TooLargeError";
  }
}

export interface WrittenFile {
  bytes: number;
  sha256: string;
}

/**
 * Streams a request body to `dest` without buffering it in memory. Bytes are counted as
 * they arrive (Content-Length is not trusted) and the transfer aborts as soon as it
 * passes `maxBytes`. Data lands in a temporary file that is renamed into place only on
 * success, so a failed or oversize upload never replaces an existing good file.
 */
export async function streamToFile(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<WrittenFile> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part-${randomBytes(6).toString("hex")}`;
  const hash = createHash("sha256");
  let bytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new TooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      meter,
      fs.createWriteStream(partial, { flags: "wx" }),
      { signal },
    );
    await fsp.rename(partial, dest);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    throw error;
  }

  return { bytes, sha256: hash.digest("hex") };
}

export async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function removeTree(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}
