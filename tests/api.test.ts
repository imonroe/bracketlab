import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { resetConfig } from "@/server/config";
import { getContext, resetContext } from "@/server/context";
import { JobPaths } from "@/server/storage/paths";
import { POST as createJob } from "@/app/api/jobs/route";
import { DELETE as deleteJob, GET as getJob } from "@/app/api/jobs/[id]/route";
import { PUT as putInput } from "@/app/api/jobs/[id]/inputs/[slot]/route";
import { POST as startJob } from "@/app/api/jobs/[id]/start/route";
import { POST as cancelJob } from "@/app/api/jobs/[id]/cancel/route";
import { GET as getArtifact } from "@/app/api/jobs/[id]/artifacts/[kind]/route";
import { makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
  process.env.BRACKETLAB_DATA_DIR = env.dir;
  process.env.BRACKETLAB_MAX_FILE_MIB = "1";
  resetConfig();
  resetContext();
});

afterEach(() => {
  resetContext();
  delete process.env.BRACKETLAB_MAX_FILE_MIB;
  env.cleanup();
});

// Route handlers receive params as a promise; the cast stands in for Next's RouteContext.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as any;

async function newJob(): Promise<{ id: string; cookie: string }> {
  const res = await createJob(new Request("http://localhost/api/jobs", { method: "POST" }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return { id: body.id, cookie };
}

function req(url: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return new Request(`http://localhost${url}`, { ...init, headers, duplex: "half" } as RequestInit);
}

async function upload(id: string, cookie: string, slot: number, data: string | Buffer, name = `DSC0${slot}.ARW`) {
  return putInput(
    req(`/api/jobs/${id}/inputs/${slot}`, cookie, {
      method: "PUT",
      body: typeof data === "string" ? data : new Uint8Array(data),
      headers: { "x-filename": encodeURIComponent(name) },
    }),
    ctx({ id, slot: String(slot) }),
  );
}

test("full upload and start flow queues the job", async () => {
  const { id, cookie } = await newJob();
  for (const slot of [0, 1, 2]) {
    const res = await upload(id, cookie, slot, `exposure-${slot}`);
    assert.equal(res.status, 200, await res.clone().text());
  }

  const started = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal(started.status, 202);
  const body = await started.json();
  assert.equal(body.state, "queued");
  assert.equal(body.queuePosition, 1);
  assert.deepEqual(body.inputs.map((i: { name: string }) => i.name), ["DSC00.ARW", "DSC01.ARW", "DSC02.ARW"]);
  assert.equal("tokenHash" in body, false);

  // Starting again is idempotent.
  const again = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal((await again.json()).state, "queued");
});

test("requests without the job's capability get 404", async () => {
  const { id } = await newJob();
  const other = await newJob();
  const res = await getJob(req(`/api/jobs/${id}`, other.cookie), ctx({ id }));
  assert.equal(res.status, 404);
  const none = await getJob(new Request(`http://localhost/api/jobs/${id}`), ctx({ id }));
  assert.equal(none.status, 404);
});

test("start rejects missing and duplicate files and returns to uploading", async () => {
  const { id, cookie } = await newJob();
  await upload(id, cookie, 0, "same");
  const missing = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal(missing.status, 422);

  await upload(id, cookie, 1, "same");
  await upload(id, cookie, 2, "different");
  const dupes = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal(dupes.status, 422);
  assert.equal((await dupes.json()).error.code, "duplicate_input");

  const job = await (await getJob(req(`/api/jobs/${id}`, cookie), ctx({ id }))).json();
  assert.equal(job.state, "uploading");
  assert.equal(job.error.code, "duplicate_input");

  // Replacing the duplicate fixes it.
  await upload(id, cookie, 1, "fixed");
  const ok = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal(ok.status, 202);
});

test("oversize uploads are rejected", async () => {
  const { id, cookie } = await newJob();
  const res = await upload(id, cookie, 0, Buffer.alloc(1024 * 1024 + 1));
  assert.equal(res.status, 413);
  assert.deepEqual(getContext().store.inputs(id), []);
});

test("queue admission limit is enforced", async () => {
  process.env.BRACKETLAB_MAX_QUEUED_JOBS = "1";
  resetConfig();
  resetContext();
  try {
    for (const expected of [202, 503]) {
      const { id, cookie } = await newJob();
      for (const slot of [0, 1, 2]) await upload(id, cookie, slot, `${id}-${slot}`);
      const res = await startJob(req(`/api/jobs/${id}/start`, cookie, { method: "POST" }), ctx({ id }));
      assert.equal(res.status, expected);
    }
  } finally {
    delete process.env.BRACKETLAB_MAX_QUEUED_JOBS;
  }
});

test("cancel before processing removes files", async () => {
  const { id, cookie } = await newJob();
  await upload(id, cookie, 0, "a");
  const root = new JobPaths(getContext().config.jobsDir, id).root;
  assert.ok(fs.existsSync(root));

  const res = await cancelJob(req(`/api/jobs/${id}/cancel`, cookie, { method: "POST" }), ctx({ id }));
  assert.equal((await res.json()).state, "canceled");
  assert.equal(fs.existsSync(root), false);
});

test("artifacts are 404 until produced", async () => {
  const { id, cookie } = await newJob();
  const res = await getArtifact(req(`/api/jobs/${id}/artifacts/dng`, cookie), ctx({ id, kind: "dng" }));
  assert.equal(res.status, 404);
  const bogus = await getArtifact(req(`/api/jobs/${id}/artifacts/toString`, cookie), ctx({ id, kind: "toString" }));
  assert.equal(bogus.status, 404);
});

test("delete removes the job, its files and clears the cookie", async () => {
  const { id, cookie } = await newJob();
  await upload(id, cookie, 0, "a");
  const root = new JobPaths(getContext().config.jobsDir, id).root;

  const res = await deleteJob(req(`/api/jobs/${id}`, cookie, { method: "DELETE" }), ctx({ id }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(getContext().store.get(id), undefined);
});
