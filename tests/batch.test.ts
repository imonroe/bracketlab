import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { POST as createBatch } from "@/app/api/batches/route";
import { DELETE as deleteBatch, GET as getBatch } from "@/app/api/batches/[id]/route";
import { POST as uploadFile } from "@/app/api/batches/[id]/files/route";
import { DELETE as removeFile } from "@/app/api/batches/[id]/files/[fileId]/route";
import { POST as submit } from "@/app/api/batches/[id]/submit/route";
import { GET as download } from "@/app/api/batches/[id]/download/route";
import { GET as artifact } from "@/app/api/batches/[id]/sets/[jobId]/[kind]/route";
import type { PublicBatch } from "@/server/batches/service";
import { resetConfig } from "@/server/config";
import { getContext, resetContext } from "@/server/context";
import { BatchPaths, JobPaths } from "@/server/storage/paths";
import { runJanitor } from "@/worker/janitor";
import { arwRecord, makeEnv, installStubExiftool, type TestEnv } from "./helpers";

let env: TestEnv;
let restoreEnv: () => void;

beforeEach(() => {
  env = makeEnv();
  process.env.BRACKETLAB_DATA_DIR = env.dir;
  restoreEnv = installStubExiftool(env.dir);
  resetConfig();
  resetContext();
});

afterEach(() => {
  resetContext();
  restoreEnv();
  delete process.env.BRACKETLAB_MAX_BATCH_FILES;
  env.cleanup();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as any;

function req(url: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return new Request(`http://localhost${url}`, { ...init, headers, duplex: "half" } as RequestInit);
}

async function newBatch() {
  const res = await createBatch(new Request("http://localhost/api/batches", { method: "POST" }));
  assert.equal(res.status, 201);
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /Path=\/api\/batches\//);
  return { id: (await res.json()).id as string, cookie: cookie.split(";")[0] };
}

/** "10:00:SS.mmm" on the test day. */
const at = (seconds: number) => {
  const whole = Math.floor(seconds);
  const ms = String(Math.round((seconds - whole) * 1000)).padStart(3, "0");
  return `2026:10:15 10:${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${ms}`;
};

async function add(id: string, cookie: string, name: string, body: string) {
  const res = await uploadFile(
    req(`/api/batches/${id}/files`, cookie, { method: "POST", body, headers: { "x-filename": name } }),
    ctx({ id }),
  );
  return { status: res.status, body: await res.json() };
}

async function status(id: string, cookie: string): Promise<PublicBatch> {
  return (await getBatch(req(`/api/batches/${id}`, cookie), ctx({ id }))).json();
}

/** Two bracket-mode sets, a stray test shot between them, and a junk file. */
async function uploadShoot(id: string, cookie: string) {
  const shots: [string, string][] = [
    ["DSC01001.ARW", arwRecord(1 / 100, { SubSecDateTimeOriginal: at(0) })],
    ["DSC01002.ARW", arwRecord(1 / 400, { SubSecDateTimeOriginal: at(0.3) })],
    ["DSC01003.ARW", arwRecord(1 / 25, { SubSecDateTimeOriginal: at(0.6) })],
    ["DSC01004.ARW", arwRecord(1 / 60, { SubSecDateTimeOriginal: at(10) })],
    ["DSC01005.ARW", arwRecord(1 / 100, { SubSecDateTimeOriginal: at(20) })],
    ["DSC01006.ARW", arwRecord(1 / 400, { SubSecDateTimeOriginal: at(20.3) })],
    ["DSC01007.ARW", arwRecord(1 / 25, { SubSecDateTimeOriginal: at(20.6) })],
    ["notes.txt", "not a raw file"],
  ];
  // Upload out of order, as parallel uploads finish.
  for (const i of [4, 0, 7, 2, 6, 1, 3, 5]) {
    const res = await add(id, cookie, shots[i][0], shots[i][1]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
}

test("a shoot is matched into sets, with strays and bad files left out", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  const batch = await status(id, cookie);
  const name = (fileId: string) => batch.files.find((f) => f.id === fileId)!.name;

  assert.equal(batch.state, "open");
  assert.deepEqual(
    batch.review!.sets.map((s) => [s.label, s.fileIds.map(name)]),
    [
      ["DSC01001-DSC01003", ["DSC01001.ARW", "DSC01002.ARW", "DSC01003.ARW"]],
      ["DSC01005-DSC01007", ["DSC01005.ARW", "DSC01006.ARW", "DSC01007.ARW"]],
    ],
  );
  assert.deepEqual(batch.review!.sets[0].order.map((o) => [name(o.fileId), o.shutter, o.evOffset]), [
    ["DSC01002.ARW", "1/400s", 0],
    ["DSC01001.ARW", "1/100s", 2],
    ["DSC01003.ARW", "1/25s", 4],
  ]);
  const unplaced = Object.fromEntries(batch.review!.unplaced.map((u) => [name(u.fileId), u.reason]));
  assert.deepEqual(Object.keys(unplaced).sort(), ["DSC01004.ARW", "notes.txt"]);
  assert.match(unplaced["notes.txt"], /^notes\.txt isn't a supported RAW file/);
});

test("removing a file re-matches the batch, flagging suspicious sets", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  let batch = await status(id, cookie);
  const victim = batch.files.find((f) => f.name === "DSC01006.ARW")!;
  const res = await removeFile(req(`/api/batches/${id}/files/${victim.id}`, cookie, { method: "DELETE" }), ctx({ id, fileId: victim.id }));
  assert.equal(res.status, 204);
  batch = await status(id, cookie);
  assert.equal(fs.existsSync(new BatchPaths(env.config.batchesDir, id).file(victim.id)), false);
  // The stray test shot now fits with the two frames left of the broken set. It is a
  // valid bracket by the rules, but its uneven spacing gets it flagged for review.
  const name = (fileId: string) => batch.files.find((f) => f.id === fileId)!.name;
  assert.deepEqual(batch.review!.sets[1].fileIds.map(name), ["DSC01004.ARW", "DSC01005.ARW", "DSC01007.ARW"]);
  assert.deepEqual(batch.review!.sets[1].warnings.map((w) => w.code), ["uneven_spacing"]);
  assert.deepEqual(batch.review!.sets[0].warnings, []);
});

test("duplicate uploads are flagged instead of matched", async () => {
  const { id, cookie } = await newBatch();
  const body = arwRecord(1 / 100, { SubSecDateTimeOriginal: at(0) });
  await add(id, cookie, "a.ARW", body);
  await add(id, cookie, "a copy.ARW", body);
  const batch = await status(id, cookie);
  const copy = batch.files.find((f) => f.name === "a copy.ARW")!;
  assert.match(batch.review!.unplaced.find((u) => u.fileId === copy.id)!.reason, /exact copy of a\.ARW/);
});

test("submitting merges only the confirmed sets and refuses a stale review", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  const review = (await status(id, cookie)).review!;

  const stale = await submit(
    req(`/api/batches/${id}/submit`, cookie, { method: "POST", body: JSON.stringify({ include: ["nope"] }) }),
    ctx({ id }),
  );
  assert.equal(stale.status, 409);

  const res = await submit(
    req(`/api/batches/${id}/submit`, cookie, { method: "POST", body: JSON.stringify({ include: [review.sets[1].key] }) }),
    ctx({ id }),
  );
  assert.equal(res.status, 202);
  const batch: PublicBatch = await res.json();
  assert.equal(batch.state, "submitted");
  assert.deepEqual(batch.jobs.map((j) => [j.label, j.state]), [["DSC01005-DSC01007", "queued"]]);

  // The set's files moved into its job; everything else is gone.
  const job = getContext().store.get(batch.jobs[0].id)!;
  assert.equal(job.batchId, id);
  for (const slot of [0, 1, 2] as const) assert.ok(fs.existsSync(new JobPaths(env.config.jobsDir, job.id).input(slot)));
  assert.equal(fs.existsSync(new BatchPaths(env.config.batchesDir, id).root), false);
  assert.deepEqual(getContext().store.inputs(job.id).map((i) => i.originalName), ["DSC01005.ARW", "DSC01006.ARW", "DSC01007.ARW"]);

  // Closed to changes now.
  const late = await add(id, cookie, "late.ARW", arwRecord(1 / 100));
  assert.equal(late.status, 409);
});

test("batch jobs don't count against the single-bracket queue", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  const keys = (await status(id, cookie)).review!.sets.map((s) => s.key);
  await submit(req(`/api/batches/${id}/submit`, cookie, { method: "POST", body: JSON.stringify({ include: keys }) }), ctx({ id }));
  assert.equal(getContext().store.countQueued(), 0);
  assert.equal(getContext().batches.countActive(), 1);
});

/** Reads a ZIP's entries (stored, non-ZIP64) from its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    assert.equal(method, 0, `${name} is stored, not compressed`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.set(name, buf.subarray(dataStart, dataStart + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("the download is one ZIP of finished DNGs with previews alongside", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  const keys = (await status(id, cookie)).review!.sets.map((s) => s.key);
  const submitted: PublicBatch = await (
    await submit(req(`/api/batches/${id}/submit`, cookie, { method: "POST", body: JSON.stringify({ include: keys }) }), ctx({ id }))
  ).json();

  const none = await download(req(`/api/batches/${id}/download`, cookie), ctx({ id }));
  assert.equal(none.status, 404);

  // Finish the first set as the worker would; leave the second unfinished.
  const { store, config } = getContext();
  const first = submitted.jobs[0];
  const paths = new JobPaths(config.jobsDir, first.id);
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.writeFileSync(paths.dng, "DNG-BYTES");
  fs.writeFileSync(paths.jpeg, "JPEG-BYTES");
  store.setArtifact(first.id, "dng", 9);
  store.transition(first.id, "queued", "merging");
  store.transition(first.id, "merging", "rendering_preview");

  // Merged but still rendering its preview: not in the ZIP yet.
  const midPreview = await download(req(`/api/batches/${id}/download`, cookie), ctx({ id }));
  assert.equal(midPreview.status, 404);

  store.setArtifact(first.id, "jpeg", 10);
  store.transition(first.id, "rendering_preview", "complete");

  const res = await download(req(`/api/batches/${id}/download`, cookie), ctx({ id }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition")!, /bracketlab-\d{4}-\d{2}-\d{2}\.zip/);
  const entries = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual([...entries.keys()], ["DSC01001-DSC01003.dng", "previews/DSC01001-DSC01003.jpg"]);
  assert.equal(entries.get("DSC01001-DSC01003.dng")!.toString(), "DNG-BYTES");

  const single = await artifact(req(`/api/batches/${id}/sets/${first.id}/dng`, cookie), ctx({ id, jobId: first.id, kind: "dng" }));
  assert.match(single.headers.get("content-disposition")!, /filename="DSC01001-DSC01003\.dng"/);
});

test("another batch's cookie gets nothing, and a job id from elsewhere is refused", async () => {
  const a = await newBatch();
  const b = await newBatch();
  assert.equal((await getBatch(req(`/api/batches/${a.id}`, b.cookie), ctx({ id: a.id }))).status, 404);
  const foreign = getContext().store.create("x", 1000);
  const res = await artifact(req(`/api/batches/${a.id}/sets/${foreign.id}/dng`, a.cookie), ctx({ id: a.id, jobId: foreign.id, kind: "dng" }));
  assert.equal(res.status, 404);
});

test("the file limit is enforced", async () => {
  process.env.BRACKETLAB_MAX_BATCH_FILES = "2";
  resetConfig();
  resetContext();
  const { id, cookie } = await newBatch();
  assert.equal((await add(id, cookie, "a.ARW", arwRecord(1 / 100))).status, 201);
  assert.equal((await add(id, cookie, "b.ARW", arwRecord(1 / 400))).status, 201);
  assert.equal((await add(id, cookie, "c.ARW", arwRecord(1 / 25))).status, 413);
});

test("deleting a batch removes its sets and files", async () => {
  const { id, cookie } = await newBatch();
  await uploadShoot(id, cookie);
  const keys = (await status(id, cookie)).review!.sets.map((s) => s.key);
  const submitted: PublicBatch = await (
    await submit(req(`/api/batches/${id}/submit`, cookie, { method: "POST", body: JSON.stringify({ include: keys }) }), ctx({ id }))
  ).json();
  const res = await deleteBatch(req(`/api/batches/${id}`, cookie, { method: "DELETE" }), ctx({ id }));
  assert.equal(res.status, 204);
  for (const job of submitted.jobs) {
    assert.equal(getContext().store.get(job.id), undefined);
    assert.equal(fs.existsSync(new JobPaths(env.config.jobsDir, job.id).root), false);
  }
});

test("the janitor expires an abandoned open batch and its files", async () => {
  const { id, cookie } = await newBatch();
  await add(id, cookie, "a.ARW", arwRecord(1 / 100));
  const { store, batches, config } = getContext();
  const report = await runJanitor(store, { ...config, uploadIdleMs: -1 }, batches);
  assert.deepEqual(report.expiredBatches, [id]);
  assert.equal(batches.get(id)!.state, "expired");
  assert.equal(fs.existsSync(new BatchPaths(config.batchesDir, id).root), false);
  assert.equal((await status(id, cookie)).state, "expired");
});
