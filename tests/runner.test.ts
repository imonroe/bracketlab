import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EngineError, type ImagingEngine } from "@/imaging/engine";
import { FakeEngine } from "@/imaging/engines";
import { JobPaths, INPUT_SLOTS } from "@/server/storage/paths";
import { runJanitor } from "@/worker/janitor";
import { runJob } from "@/worker/runner";
import { makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

const quiet = () => {};

function queuedJob() {
  const job = env.store.create("h", env.config.retentionMs);
  const paths = new JobPaths(env.config.jobsDir, job.id);
  fs.mkdirSync(paths.inputsDir, { recursive: true });
  for (const slot of INPUT_SLOTS) {
    fs.writeFileSync(paths.input(slot), `raw-${slot}`);
    env.store.putInput(job.id, { slot, originalName: `f${slot}`, bytes: 5, sha256: `s${slot}` });
  }
  env.store.transition(job.id, "uploading", "validating");
  env.store.transition(job.id, "validating", "queued", { nextStage: "merge" });
  return { claimed: env.store.claimNext()!, paths };
}

function deps(engine: ImagingEngine, shutdown = new AbortController().signal) {
  return { store: env.store, config: env.config, engine, log: quiet, shutdown, watchIntervalMs: 10 };
}

test("a successful run publishes both artifacts and removes inputs", async () => {
  const { claimed, paths } = queuedJob();
  await runJob(deps(new FakeEngine(0)), claimed);

  const job = env.store.get(claimed.id)!;
  assert.equal(job.state, "complete");
  assert.ok(job.dngBytes && job.jpegBytes);
  assert.ok(fs.existsSync(paths.dng) && fs.existsSync(paths.jpeg));
  assert.equal(fs.existsSync(paths.inputsDir), false);
  assert.equal(fs.existsSync(paths.workDir), false);
  assert.deepEqual((job.manifest as { inputs: unknown[] }).inputs.length, 3);
});

test("a preview failure keeps the DNG and allows a preview-only retry", async () => {
  const { claimed, paths } = queuedJob();
  let previewCalls = 0;
  let mergeCalls = 0;
  const flaky: ImagingEngine = {
    name: "flaky",
    async merge(r) {
      mergeCalls++;
      fs.writeFileSync(r.output, "dng");
      return { engine: { name: "flaky" } };
    },
    async renderPreview(r) {
      if (previewCalls++ === 0) throw new EngineError("render", "Renderer crashed.");
      fs.writeFileSync(r.output, "jpg");
    },
  };

  await runJob(deps(flaky), claimed);
  let job = env.store.get(claimed.id)!;
  assert.equal(job.state, "raw_ready_preview_failed");
  assert.equal(job.errorMessage, "Renderer crashed.");
  assert.ok(fs.existsSync(paths.dng));

  env.store.transition(job.id, "raw_ready_preview_failed", "queued", { nextStage: "preview" });
  await runJob(deps(flaky), env.store.claimNext()!);
  job = env.store.get(claimed.id)!;
  assert.equal(job.state, "complete");
  assert.equal(mergeCalls, 1);
});

test("a merge failure shows the engine's message, not internals", async () => {
  const { claimed, paths } = queuedJob();
  const broken: ImagingEngine = {
    name: "broken",
    async merge() {
      throw new Error("segfault at 0xdeadbeef");
    },
    async renderPreview() {},
  };
  await runJob(deps(broken), claimed);
  const job = env.store.get(claimed.id)!;
  assert.equal(job.state, "failed");
  assert.equal(job.errorCode, "internal_error");
  assert.doesNotMatch(job.errorMessage!, /deadbeef/);
  assert.equal(fs.existsSync(paths.root), false);
});

test("canceling during the merge aborts the engine and publishes nothing", async () => {
  const { claimed, paths } = queuedJob();
  const running = runJob(deps(new FakeEngine(5000)), claimed);
  await delay(30);
  env.store.transition(claimed.id, "merging", "canceled");
  await running;

  assert.equal(env.store.get(claimed.id)!.state, "canceled");
  assert.equal(fs.existsSync(paths.root), false);
});

test("shutdown leaves the job for startup reconciliation", async () => {
  const { claimed } = queuedJob();
  const shutdown = new AbortController();
  const running = runJob(deps(new FakeEngine(5000), shutdown.signal), claimed);
  await delay(30);
  shutdown.abort();
  await running;
  assert.equal(env.store.get(claimed.id)!.state, "merging");

  const [interrupted] = env.store.reconcileInterrupted();
  assert.equal(interrupted.state, "failed");
  assert.ok(interrupted.retryable);
});

test("janitor expires old jobs and removes orphaned folders", async () => {
  const { claimed, paths } = queuedJob();
  await runJob(deps(new FakeEngine(0)), claimed);
  const orphan = new JobPaths(env.config.jobsDir, "11111111-2222-4333-8444-555555555555");
  fs.mkdirSync(orphan.root, { recursive: true });

  env.clock.now += env.config.retentionMs + 1;
  const report = await runJanitor(env.store, env.config);

  assert.deepEqual(report.expired, [claimed.id]);
  assert.deepEqual(report.orphans, ["11111111-2222-4333-8444-555555555555"]);
  const job = env.store.get(claimed.id)!;
  assert.equal(job.state, "expired");
  assert.equal(job.dngBytes, null);
  assert.equal(fs.existsSync(paths.root), false);
  assert.equal(fs.existsSync(orphan.root), false);
});
