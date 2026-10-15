import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY } from "@/imaging/bracket";
import type { FileExposure } from "@/imaging/metadata";
import { preflight } from "@/imaging/preflight";
import type { JobInput } from "@/server/jobs/store";

const exposure = (exposureTime: number, extra: Partial<FileExposure> = {}): FileExposure => ({
  fileType: "ARW",
  make: "SONY",
  model: "ILCE-6100",
  iso: 100,
  fNumber: 8,
  focalLength: 16,
  exposureTime,
  ...extra,
});

function input(slot: number, e: FileExposure | null, extra: Partial<JobInput> = {}): JobInput {
  return {
    slot,
    originalName: `f${slot}.ARW`,
    bytes: 10,
    sha256: `sha${slot}`,
    uploadedAt: 0,
    exposure: e,
    metadataError: null,
    ...extra,
  };
}

test("an incomplete bracket only reports what is wrong so far", () => {
  const result = preflight([input(0, exposure(1 / 100))], DEFAULT_POLICY);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["wrong_count"]);
  assert.equal(result.order, null);
});

test("a bad file is flagged against its slot as soon as it uploads", () => {
  const result = preflight([input(1, exposure(1 / 100, { fileType: "JPEG" }))], DEFAULT_POLICY);
  assert.deepEqual(result.byInput[1].map((e) => e.code), ["unsupported_format"]);
  assert.match(result.byInput[1][0].message, /^File 2 /);
});

test("unreadable metadata is a per-file error", () => {
  const result = preflight([input(0, null, { metadataError: "boom" })], DEFAULT_POLICY);
  assert.deepEqual(result.byInput[0].map((e) => e.code), ["metadata_unreadable"]);
  assert.doesNotMatch(result.byInput[0][0].message, /boom/);
});

test("a file uploaded before checks were on asks to be replaced", () => {
  const result = preflight([input(0, null)], DEFAULT_POLICY);
  assert.deepEqual(result.byInput[0].map((e) => e.code), ["metadata_unchecked"]);
});

test("a complete valid bracket is ordered by exposure", () => {
  const result = preflight(
    [input(0, exposure(1 / 100)), input(1, exposure(1 / 400)), input(2, exposure(1 / 25))],
    DEFAULT_POLICY,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.order, [
    { slot: 1, evOffset: 0 },
    { slot: 0, evOffset: 2 },
    { slot: 2, evOffset: 4 },
  ]);
});

test("whole-bracket problems wait for all three files", () => {
  const result = preflight(
    [input(0, exposure(1 / 100)), input(1, exposure(1 / 100)), input(2, exposure(1 / 25))],
    DEFAULT_POLICY,
  );
  assert.deepEqual(result.errors.map((e) => e.code), ["exposures_not_distinct"]);
  assert.deepEqual(result.byInput, {});
});

test("duplicates are caught by checksum with or without metadata", () => {
  const dupes = [input(0, null), input(1, null, { sha256: "sha0" }), input(2, null)];
  assert.deepEqual(preflight(dupes, null).errors.map((e) => e.code), ["duplicate_input"]);
  assert.deepEqual(preflight(dupes, null).byInput[1].map((e) => e.code), ["duplicate_input"]);
});

test("without a policy, metadata is not required", () => {
  const result = preflight([input(0, null), input(1, null), input(2, null)], null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.order, null);
});
