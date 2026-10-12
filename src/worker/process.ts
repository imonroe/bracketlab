import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  /** Defaults to just PATH. Native tools should not inherit the server's environment. */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** How much trailing stdout/stderr to keep for diagnostics. */
  maxOutputBytes?: number;
  /** Exit codes that count as success. ExifTool, for one, exits 1 when any file fails. */
  okExitCodes?: number[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly reason: "exit" | "timeout" | "aborted" | "spawn",
    readonly exitCode: number | null,
    readonly signalName: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

/** Keeps only the last `max` bytes of a growing output stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.max)).toString("utf8");
  }
}

/**
 * Runs a native tool with an argument array (never a shell string) in its own process
 * group. Cancellation and timeouts signal the whole group, so helpers the tool spawns
 * die with it. Resolves only after the process has fully exited.
 */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { signal, timeoutMs, killGraceMs = 5000, maxOutputBytes = 64 * 1024, okExitCodes = [0] } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessError(`${command} was canceled`, "aborted", null, null, ""));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      // Next.js augments ProcessEnv with a required NODE_ENV that tools don't need.
      env: (options.env ?? { PATH: process.env.PATH }) as unknown as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new Tail(maxOutputBytes);
    const stderr = new Tail(maxOutputBytes);
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));

    let stopReason: "timeout" | "aborted" | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // The group already exited.
      }
    };

    const stop = (reason: "timeout" | "aborted") => {
      if (stopReason) return;
      stopReason = reason;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };

    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      cleanup();
      reject(new ProcessError(`${command} could not start: ${error.message}`, "spawn", null, null, ""));
    });

    child.on("close", (code, sig) => {
      cleanup();
      // Make sure nothing in the group outlives the leader.
      killGroup("SIGKILL");
      if (stopReason === "timeout") {
        reject(new ProcessError(`${command} timed out`, "timeout", code, sig, stderr.toString()));
      } else if (stopReason === "aborted") {
        reject(new ProcessError(`${command} was canceled`, "aborted", code, sig, stderr.toString()));
      } else if (code === null || !okExitCodes.includes(code)) {
        reject(
          new ProcessError(
            `${command} exited with ${code ?? sig}`,
            "exit",
            code,
            sig,
            stderr.toString(),
          ),
        );
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}
