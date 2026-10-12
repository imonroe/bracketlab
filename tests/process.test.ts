import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProcessError, runProcess } from "@/worker/process";

/** Running and not a zombie. Containers without an init may never reap orphans. */
function isAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

test("captures output of a successful command", async () => {
  const { stdout } = await runProcess("sh", ["-c", "echo hi"], { timeoutMs: 5000 });
  assert.equal(stdout.trim(), "hi");
});

test("does not pass the server environment through", async () => {
  process.env.BRACKETLAB_SECRET_TEST = "leak";
  const { stdout } = await runProcess("sh", ["-c", "echo \"[$BRACKETLAB_SECRET_TEST]\""], { timeoutMs: 5000 });
  delete process.env.BRACKETLAB_SECRET_TEST;
  assert.equal(stdout.trim(), "[]");
});

test("non-zero exit rejects with stderr", async () => {
  await assert.rejects(runProcess("sh", ["-c", "echo boom >&2; exit 3"], { timeoutMs: 5000 }), (e: ProcessError) => {
    assert.equal(e.reason, "exit");
    assert.equal(e.exitCode, 3);
    assert.match(e.stderr, /boom/);
    return true;
  });
});

test("abort kills the whole process group, including grandchildren", async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bl-proc-")), "pid");
  const controller = new AbortController();
  const run = runProcess("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
    timeoutMs: 10_000,
    signal: controller.signal,
    killGraceMs: 500,
  });
  while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
    await new Promise((r) => setTimeout(r, 20));
  }
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(run, (e: ProcessError) => e.reason === "aborted");
  // If only the leader died, the orphaned sleep would hold stdout open for 30s.
  assert.ok(Date.now() - abortedAt < 3000, "abort should settle promptly");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAlive(grandchild), false);
});

test("listed non-zero exit codes count as success", async () => {
  const { stdout } = await runProcess("sh", ["-c", "echo partial; exit 1"], { timeoutMs: 5000, okExitCodes: [0, 1] });
  assert.equal(stdout.trim(), "partial");
  await assert.rejects(runProcess("sh", ["-c", "exit 2"], { timeoutMs: 5000, okExitCodes: [0, 1] }));
});

test("timeout rejects", async () => {
  await assert.rejects(
    runProcess("sleep", ["10"], { timeoutMs: 100, killGraceMs: 100 }),
    (e: ProcessError) => e.reason === "timeout",
  );
});
