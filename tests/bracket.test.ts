import assert from "node:assert/strict";
import { test } from "node:test";
import { bracketPolicyFromEnv, checkBracket, checkFrame, type ExposureInfo } from "@/imaging/bracket";

/** A valid ±2 EV a6100 bracket, given in slot order (middle, dark, bright). */
function bracket(overrides: Partial<ExposureInfo>[] = []): ExposureInfo[] {
  const base: ExposureInfo[] = [
    { index: 0, exposureTime: 1 / 100 },
    { index: 1, exposureTime: 1 / 400 },
    { index: 2, exposureTime: 1 / 25 },
  ].map((f, i) => ({
    fileType: "ARW",
    make: "SONY",
    model: "ILCE-6100",
    iso: 100,
    fNumber: 8,
    focalLength: 16,
    dateTimeOriginal: `2026:10:12 10:00:0${i}`,
    ...f,
  }));
  return base.map((f, i) => ({ ...f, ...overrides[i] }));
}

const codes = (frames: ExposureInfo[], policy?: Parameters<typeof checkBracket>[1]) =>
  checkBracket(frames, policy).errors.map((e) => e.code);

test("a valid bracket is ordered dark to bright with EV offsets", () => {
  const result = checkBracket(bracket());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.order, [1, 0, 2]);
  assert.deepEqual(result.evOffsets, [0, 2, 4]);
});

test("asymmetric spacing is allowed", () => {
  const result = checkBracket(bracket([{ exposureTime: 1 / 200 }]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.evOffsets, [0, 1, 4]);
});

test("wrong count is rejected", () => {
  assert.deepEqual(codes(bracket().slice(0, 2)), ["wrong_count"]);
});

test("non-RAW files are rejected before anything else", () => {
  assert.deepEqual(codes(bracket([{ fileType: "JPEG" }])), ["unsupported_format"]);
  assert.match(checkBracket(bracket([{ fileType: "JPEG" }])).errors[0].message, /^File 1.*JPEG/);
});

test("unsupported cameras are flagged per file", () => {
  assert.deepEqual(codes(bracket([{ model: "X" }, { model: "X" }, { model: "X" }])), [
    "unsupported_camera",
    "unsupported_camera",
    "unsupported_camera",
  ]);
  assert.deepEqual(codes(bracket([{ model: "X" }, { model: "X" }, { model: "X" }]), { supportedModels: ["*"], maxCaptureSpanSeconds: 30 }), []);
});

test("mixed cameras are rejected even when each is supported", () => {
  const anyModel = { supportedModels: ["*"], maxCaptureSpanSeconds: 30 };
  assert.deepEqual(codes(bracket([{ model: "ILCE-7M3" }]), anyModel), ["mixed_cameras"]);
});

test("checkFrame judges one file on its own", () => {
  const [ok] = bracket();
  assert.deepEqual(checkFrame(ok), []);
  assert.deepEqual(checkFrame({ ...ok, fileType: undefined }).map((i) => i.code), ["unsupported_format"]);
  assert.deepEqual(checkFrame({ ...ok, index: 2, iso: undefined }).map((i) => i.message.slice(0, 6)), ["File 3"]);
});

test("the supported-model list comes from the environment", () => {
  assert.deepEqual(bracketPolicyFromEnv({}).supportedModels, ["ILCE-6100"]);
  assert.deepEqual(bracketPolicyFromEnv({ BRACKETLAB_SUPPORTED_MODELS: " ILCE-6100, ILCE-7M3 ," }).supportedModels, ["ILCE-6100", "ILCE-7M3"]);
});

test("missing exposure metadata is rejected rather than guessed", () => {
  assert.deepEqual(codes(bracket([{}, { exposureTime: undefined }])), ["missing_exposure"]);
  assert.deepEqual(codes(bracket([{ iso: undefined }])), ["missing_exposure"]);
});

test("ISO, aperture and focal length must stay fixed", () => {
  assert.deepEqual(codes(bracket([{ iso: 200 }])), ["iso_differs"]);
  assert.deepEqual(codes(bracket([{ fNumber: 5.6 }])), ["aperture_differs"]);
  assert.deepEqual(codes(bracket([{ focalLength: 50 }])), ["focal_length_differs"]);
  // Rounding noise in reported values is not a difference.
  assert.deepEqual(codes(bracket([{ fNumber: 8.0001 }])), []);
});

test("unknown focal length is not an error", () => {
  assert.deepEqual(codes(bracket([{ focalLength: undefined }])), []);
});

test("three exposures must be distinct", () => {
  assert.deepEqual(codes(bracket([{ exposureTime: 1 / 400 }])), ["exposures_not_distinct"]);
});

test("unevenly spaced exposures are a warning, not an error", () => {
  const result = checkBracket(bracket([{ exposureTime: 1 / 200 }]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map((w) => w.code), ["uneven_spacing"]);
  assert.match(result.warnings[0].message, /\+1 EV, then \+3 EV/);
  assert.deepEqual(checkBracket(bracket()).warnings, []);
});

test("a long gap between shots is a warning, not an error", () => {
  const result = checkBracket(bracket([{}, {}, { dateTimeOriginal: "2026:10:12 10:05:00" }]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map((w) => w.code), ["capture_gap"]);
});
