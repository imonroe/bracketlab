import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { InvalidTransitionError } from "@/server/jobs/states";
import { makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

const input = (slot: number, sha = `sha${slot}`) => ({ slot, originalName: `f${slot}.ARW`, bytes: 10, sha256: sha });

test("create sets uploading state and expiry from retention", () => {
  const job = env.store.create("hash", 1000);
  assert.equal(job.state, "uploading");
  assert.equal(job.expiresAt, env.clock.now + 1000);
  assert.equal(job.retryable, false);
});

test("inputs can be replaced while uploading but not after", () => {
  const job = env.store.create("hash", 1000);
  env.store.putInput(job.id, input(0, "a"));
  env.store.putInput(job.id, input(0, "b"));
  assert.deepEqual(env.store.inputs(job.id).map((i) => i.sha256), ["b"]);

  env.store.transition(job.id, "uploading", "validating");
  assert.throws(() => env.store.putInput(job.id, input(1)), /not accepting uploads/);
});

test("transition is compare-and-swap", () => {
  const job = env.store.create("hash", 1000);
  assert.equal(env.store.transition(job.id, "queued", "merging"), undefined);
  assert.equal(env.store.get(job.id)?.state, "uploading");
  assert.equal(env.store.transition(job.id, "uploading", "validating")?.state, "validating");
});

test("transition rejects edges outside the lifecycle", () => {
  const job = env.store.create("hash", 1000);
  assert.throws(() => env.store.transition(job.id, "uploading", "complete"), InvalidTransitionError);
});

test("claimNext takes the oldest queued job and routes by next stage", () => {
  const a = env.store.create("h", 1000);
  const b = env.store.create("h", 1000);
  for (const job of [a, b]) {
    env.store.transition(job.id, "uploading", "validating");
  }
  env.store.transition(b.id, "validating", "queued", { nextStage: "merge" });
  env.clock.now += 10;
  env.store.transition(a.id, "validating", "queued", { nextStage: "merge" });

  assert.equal(env.store.queuePosition(b.id), 1);
  assert.equal(env.store.queuePosition(a.id), 2);
  assert.equal(env.store.countQueued(), 2);

  const first = env.store.claimNext();
  assert.equal(first?.id, b.id);
  assert.equal(first?.state, "merging");
  assert.equal(env.store.claimNext()?.id, a.id);
  assert.equal(env.store.claimNext(), undefined);
});

test("claimNext sends preview retries straight to rendering", () => {
  const job = env.store.create("h", 1000);
  env.store.transition(job.id, "uploading", "validating");
  env.store.transition(job.id, "validating", "queued", { nextStage: "preview" });
  assert.equal(env.store.claimNext()?.state, "rendering_preview");
});

test("reconcileInterrupted fails active jobs as retryable", () => {
  const merging = env.store.create("h", 1000);
  env.store.transition(merging.id, "uploading", "validating");
  env.store.transition(merging.id, "validating", "queued", { nextStage: "merge" });
  env.store.claimNext();

  const idle = env.store.create("h", 1000);
  const [failed] = env.store.reconcileInterrupted();
  assert.equal(failed.id, merging.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorCode, "interrupted");
  assert.equal(failed.nextStage, "merge");
  assert.equal(env.store.get(idle.id)?.state, "uploading");
});

test("listExpirable finds expired results and abandoned uploads", () => {
  const done = env.store.create("h", 1000);
  const stale = env.store.create("h", 1_000_000);
  const fresh = env.store.create("h", 1_000_000);

  env.clock.now += 5000;
  env.store.putInput(fresh.id, input(0));

  const ids = env.store.listExpirable(3000).map((j) => j.id).sort();
  assert.deepEqual(ids, [done.id, stale.id].sort());
});

test("deleting a job removes its inputs", () => {
  const job = env.store.create("h", 1000);
  env.store.putInput(job.id, input(0));
  assert.ok(env.store.delete(job.id));
  assert.deepEqual(env.store.inputs(job.id), []);
});
