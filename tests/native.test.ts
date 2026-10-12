import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_POLICY } from "@/imaging/bracket";
import { EngineError } from "@/imaging/engine";
import { NativeEngine } from "@/imaging/native";
import { ProcessError } from "@/worker/process";

/**
 * Exercises the native engine against stub tools. Each stub is a shell script that reads
 * its behaviour from files next to it (the engine passes tools a minimal environment)
 * and records how it was called.
 */

let dir: string;
let work: string;
let inputs: string[];

const EXIF_OK = [
  { FileType: "ARW", Make: "SONY", Model: "ILCE-6100", ISO: 100, FNumber: 8, ExposureTime: 0.01, FocalLength: 16 },
  { FileType: "ARW", Make: "SONY", Model: "ILCE-6100", ISO: 100, FNumber: 8, ExposureTime: 0.0025, FocalLength: 16 },
  { FileType: "ARW", Make: "SONY", Model: "ILCE-6100", ISO: 100, FNumber: 8, ExposureTime: 0.04, FocalLength: 16 },
];
const DNG_OK = [{ DNGVersion: "1.4.0.0", SampleFormat: 3, PhotometricInterpretation: 32803 }];

function stub(name: string, body: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\nD="$(dirname "$0")"\necho "$*" >> "$D/${name}.calls"\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function setting(name: string, value: string | object) {
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

function calls(name: string): string[] {
  const file = path.join(dir, `${name}.calls`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}

function engine() {
  return new NativeEngine({
    hdrmerge: path.join(dir, "hdrmerge"),
    darktableCli: path.join(dir, "darktable-cli"),
    exiftool: path.join(dir, "exiftool"),
    policy: DEFAULT_POLICY,
    versions: { hdrmerge: "test", darktable: "test" },
  });
}

const request = (signal = new AbortController().signal) => ({
  inputs,
  output: path.join(work, "merged.dng"),
  workDir: work,
  signal,
  timeoutMs: 10_000,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-native-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
  inputs = [0, 1, 2].map((i) => path.join(dir, `input-${i}.raw`));
  for (const f of inputs) fs.writeFileSync(f, "raw");

  setting("exif.json", EXIF_OK);
  setting("dng.json", DNG_OK);
  setting("hdrmerge.mode", "ok");
  stub(
    "exiftool",
    `case "$*" in
  *-overwrite_original*) exit 0 ;;
  *-DNGVersion*) cat "$D/dng.json" ;;
  *) cat "$D/exif.json"; [ -f "$D/exif.exit" ] && exit "$(cat "$D/exif.exit")" ;;
esac`,
  );
  stub(
    "hdrmerge",
    `echo "HOME=$HOME QT=$QT_QPA_PLATFORM" > "$D/hdrmerge.env"
mode="$(cat "$D/hdrmerge.mode")"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
case "$mode" in
  ok) echo "Using white level 15871"; echo "Image 1 displaced to (2, -1) with error 0.5"; echo "Image 0 displaced to (0, 0) with error 0"; echo dng > "$out" ;;
  format) echo "Error loading $4, it has a different format." >&2 ;;
  unreadable) echo "Error loading $4, file not found." >&2 ;;
  silent) ;;
  slow) sleep 30 ;;
esac
exit 0`,
  );
  stub("darktable-cli", `[ -f "$D/darktable.fail" ] && exit 1\necho jpg > "$2"`);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("merge orders exposures, runs HDRMerge with the PRD options and reports details", async () => {
  const result = await engine().merge(request());
  assert.ok(fs.existsSync(path.join(work, "merged.dng")));

  const [call] = calls("hdrmerge");
  // Darkest (slot 1) to brightest (slot 2).
  assert.ok(call.endsWith(`${inputs[1]} ${inputs[0]} ${inputs[2]}`), call);
  assert.match(call, /-p none -b 16 -o /);

  const env = fs.readFileSync(path.join(dir, "hdrmerge.env"), "utf8");
  assert.match(env, new RegExp(`HOME=${work}/home QT=offscreen`));

  const details = result.details as Record<string, unknown>;
  assert.deepEqual(
    (details.exposures as { slot: number; evOffset: number }[]).map((e) => [e.slot, e.evOffset]),
    [[1, 0], [0, 2], [2, 4]],
  );
  assert.deepEqual(details.alignment, [
    { image: 1, dx: 2, dy: -1, error: 0.5 },
    { image: 0, dx: 0, dy: 0, error: 0 },
  ]);
  assert.equal(details.whiteLevel, 15871);
});

test("an unreadable file is reported per file, not blamed on HDRMerge", async () => {
  // ExifTool exits 1 and returns an empty record for a file it can't read.
  setting("exif.json", [EXIF_OK[0], {}, EXIF_OK[2]]);
  setting("exif.exit", "1");
  await assert.rejects(engine().merge(request()), (e: EngineError) => {
    assert.equal(e.code, "unsupported_format");
    assert.match(e.userMessage, /^File 2 isn't a supported RAW file/);
    return true;
  });
  assert.deepEqual(calls("hdrmerge"), []);
});

test("a bad bracket is rejected before HDRMerge runs", async () => {
  setting("exif.json", EXIF_OK.map((f) => ({ ...f, ExposureTime: 0.01 })));
  await assert.rejects(engine().merge(request()), (e: EngineError) => e.code === "exposures_not_distinct");
  assert.deepEqual(calls("hdrmerge"), []);
});

for (const [mode, code] of [
  ["format", "inputs_mismatched"],
  ["unreadable", "input_unreadable"],
  ["silent", "merge_failed"],
] as const) {
  test(`HDRMerge exiting 0 without a DNG (${mode}) is a failure`, async () => {
    setting("hdrmerge.mode", mode);
    await assert.rejects(engine().merge(request()), (e: EngineError) => {
      assert.equal(e.code, code);
      // Internal paths stay in the log detail, out of the user message.
      assert.doesNotMatch(e.userMessage, /input-\d\.raw|\//);
      return true;
    });
  });
}

test("a DNG that isn't floating-point CFA data is rejected", async () => {
  setting("dng.json", [{ DNGVersion: "1.4.0.0", SampleFormat: 1, PhotometricInterpretation: 32803 }]);
  await assert.rejects(engine().merge(request()), (e: EngineError) => e.code === "invalid_output");
});

test("cancellation passes through as an abort, not an engine error", async () => {
  setting("hdrmerge.mode", "slow");
  const controller = new AbortController();
  const run = engine().merge(request(controller.signal));
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(run, (e: ProcessError) => e instanceof ProcessError && e.reason === "aborted");
});

test("preview renders with an isolated darktable config and strips metadata", async () => {
  const output = path.join(work, "preview.jpg");
  await engine().renderPreview({ dng: path.join(work, "merged.dng"), output, workDir: work, signal: new AbortController().signal, timeoutMs: 10_000 });
  assert.ok(fs.existsSync(output));

  const [dt] = calls("darktable-cli");
  assert.match(dt, /--width 2560 --height 2560/);
  assert.match(dt, /--apply-custom-presets false/);
  assert.match(dt, new RegExp(`--configdir ${work}/darktable/config`));
  assert.match(dt, /--library :memory:/);

  const strip = calls("exiftool").find((c) => c.includes("-overwrite_original"));
  assert.ok(strip?.includes("-all=") && strip.endsWith(output), strip);
});

test("a darktable failure becomes a preview error", async () => {
  setting("darktable.fail", "1");
  await assert.rejects(
    engine().renderPreview({ dng: "x.dng", output: path.join(work, "p.jpg"), workDir: work, signal: new AbortController().signal, timeoutMs: 10_000 }),
    (e: EngineError) => e.code === "preview_failed",
  );
});
