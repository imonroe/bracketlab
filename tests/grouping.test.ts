import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY } from "@/imaging/bracket";
import { matchBrackets, type MatchFile } from "@/imaging/grouping";

let counter = 0;

/** A frame shot `seconds` after 10:00:00, with the given shutter speed. */
function shot(seconds: number, exposureTime: number, extra: Partial<NonNullable<MatchFile["exposure"]>> = {}): MatchFile {
  counter += 1;
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  const hh = String(10 + Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return {
    id: `f${counter}`,
    name: `DSC0${1000 + counter}.ARW`,
    issues: [],
    exposure: {
      fileType: "ARW",
      make: "SONY",
      model: "ILCE-6100",
      iso: 100,
      fNumber: 8,
      focalLength: 16,
      exposureTime,
      dateTimeOriginal: `2026:10:15 ${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}+02:00`,
      ...extra,
    },
  };
}

/** A bracket-mode set: 0, -2, +2 EV, a third of a second apart (the a6100's default order). */
const bracketMode = (start: number) => [shot(start, 1 / 100), shot(start + 0.3, 1 / 400), shot(start + 0.6, 1 / 25)];

const match = (files: MatchFile[]) => matchBrackets(files, { policy: DEFAULT_POLICY });
const names = (files: MatchFile[], ids: string[]) => ids.map((id) => files.find((f) => f.id === id)!.name);

test("consecutive bracket-mode sets are matched in order", () => {
  const files = [...bracketMode(0), ...bracketMode(20), ...bracketMode(45)];
  const { sets, unplaced } = match(files);
  assert.equal(sets.length, 3);
  assert.deepEqual(unplaced, []);
  assert.deepEqual(sets.map((s) => s.fileIds), [files.slice(0, 3), files.slice(3, 6), files.slice(6, 9)].map((g) => g.map((f) => f.id)));
  assert.deepEqual(sets[0].order.map((o) => o.evOffset), [0, 2, 4]);
  assert.equal(sets[0].order[0].fileId, files[1].id, "darkest first");
});

test("upload order doesn't matter; capture time does", () => {
  const files = [...bracketMode(0), ...bracketMode(20)];
  const shuffled = [files[4], files[0], files[5], files[2], files[1], files[3]];
  const { sets } = match(shuffled);
  assert.deepEqual(sets.map((s) => names(shuffled, s.fileIds)), [
    files.slice(0, 3).map((f) => f.name),
    files.slice(3).map((f) => f.name),
  ]);
});

test("a stray test shot is left out without shifting the sets after it", () => {
  const before = bracketMode(0);
  const stray = shot(10, 1 / 60);
  const after = bracketMode(12);
  const files = [...before, stray, ...after];
  const { sets, unplaced } = match(files);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[1].fileIds, after.map((f) => f.id));
  assert.deepEqual(unplaced.map((u) => u.fileId), [stray.id]);
  assert.match(unplaced[0].reason, /Couldn't be matched/);
});

test("hand-bracketed sets a few seconds apart match alongside bracket-mode sets", () => {
  const manual = [shot(30, 1 / 400), shot(34, 1 / 100), shot(39, 1 / 25)];
  const files = [...bracketMode(0), ...manual, ...bracketMode(90)];
  const { sets, unplaced } = match(files);
  assert.equal(sets.length, 3);
  assert.deepEqual(unplaced, []);
  assert.equal(sets[1].spanSeconds, 9);
});

test("a set taking longer than a minute is not matched", () => {
  const files = [shot(0, 1 / 400), shot(40, 1 / 100), shot(80, 1 / 25)];
  const { sets, unplaced } = match(files);
  assert.equal(sets.length, 0);
  assert.equal(unplaced.length, 3);
});

test("a set with a changed ISO is not matched", () => {
  const files = [shot(0, 1 / 100), shot(0.3, 1 / 400, { iso: 400 }), shot(0.6, 1 / 25)];
  assert.equal(match(files).sets.length, 0);
});

test("of two valid alignments, the tighter sets win", () => {
  // a b c d: both (a b c) and (b c d) are valid; b c d are bracket-mode tight, a is 20s earlier.
  const a = shot(0, 1 / 25);
  const tight = bracketMode(20);
  const { sets, unplaced } = match([a, ...tight]);
  assert.deepEqual(sets[0].fileIds, tight.map((f) => f.id));
  assert.deepEqual(unplaced.map((u) => u.fileId), [a.id]);
});

test("files with known problems are unplaced with their reason, named by file", () => {
  const bad = shot(5, 1 / 100, { fileType: "JPEG" });
  const unreadable: MatchFile = { ...shot(6, 1 / 100), issues: [{ code: "metadata_unreadable", message: "x.ARW couldn't be read." }] };
  const noTime = shot(7, 1 / 100, { dateTimeOriginal: undefined });
  const { unplaced } = match([...bracketMode(0), bad, unreadable, noTime]);
  const reasons = Object.fromEntries(unplaced.map((u) => [u.fileId, u.reason]));
  assert.match(reasons[bad.id], new RegExp(`^${bad.name.replace(".", "\\.")} isn't a supported RAW file`));
  assert.equal(reasons[unreadable.id], "x.ARW couldn't be read.");
  assert.match(reasons[noTime.id], /no capture time/);
});

test("set keys change when membership changes", () => {
  const files = bracketMode(0);
  const key = match(files).sets[0].key;
  assert.equal(match([...files].reverse()).sets[0].key, key);
  assert.notEqual(match([...files.slice(0, 2), shot(0.6, 1 / 30)]).sets[0]?.key, key);
});
