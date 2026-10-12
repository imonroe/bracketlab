import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TooLargeError, streamToFile } from "@/server/storage/files";
import { JobPaths, parseSlot } from "@/server/storage/paths";
import { makeEnv, sha256Hex, streamOf, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

test("streams to disk with byte count and checksum", async () => {
  const dest = path.join(env.dir, "a", "file.raw");
  const result = await streamToFile(streamOf("hello ", "world"), dest, 100);
  assert.deepEqual(result, { bytes: 11, sha256: sha256Hex("hello world") });
  assert.equal(fs.readFileSync(dest, "utf8"), "hello world");
});

test("oversize upload fails, leaves no partial file, and keeps the previous file", async () => {
  const dest = path.join(env.dir, "file.raw");
  fs.writeFileSync(dest, "previous");
  await assert.rejects(streamToFile(streamOf("12345", "67890"), dest, 8), TooLargeError);
  assert.equal(fs.readFileSync(dest, "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(env.dir).filter((f) => f.startsWith("file.raw")), ["file.raw"]);
});

test("paths reject anything but a UUID job id and known slots", () => {
  assert.throws(() => new JobPaths(env.dir, "../etc"), /Invalid job id/);
  assert.equal(parseSlot("3"), undefined);
  assert.equal(parseSlot("01"), undefined);
  assert.equal(parseSlot("2"), 2);
});
