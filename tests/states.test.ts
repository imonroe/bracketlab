import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_STATES, canTransition, isCancelable } from "@/server/jobs/states";

test("happy path is a chain of allowed transitions", () => {
  const path = ["uploading", "validating", "queued", "merging", "rendering_preview", "complete"] as const;
  for (let i = 1; i < path.length; i++) assert.ok(canTransition(path[i - 1], path[i]), `${path[i - 1]} -> ${path[i]}`);
});

test("expired is terminal and every state can eventually expire or end", () => {
  for (const to of JOB_STATES) assert.equal(canTransition("expired", to), false);
  assert.ok(canTransition("complete", "expired"));
  assert.ok(canTransition("raw_ready_preview_failed", "expired"));
});

test("a failed preview can only be retried by re-queueing", () => {
  assert.ok(canTransition("raw_ready_preview_failed", "queued"));
  assert.equal(canTransition("raw_ready_preview_failed", "merging"), false);
});

test("finished jobs are not cancelable", () => {
  assert.equal(isCancelable("complete"), false);
  assert.equal(isCancelable("failed"), false);
  assert.ok(isCancelable("merging"));
});
