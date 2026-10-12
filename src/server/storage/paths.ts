import path from "node:path";

/**
 * Every path on disk is derived from validated job IDs and fixed names. Upload filenames
 * are stored in the database for display only and never touch the filesystem.
 *
 *   <jobsDir>/<jobId>/
 *     inputs/input-<slot>.raw
 *     work/                     scratch space for native tools
 *     output/merged.dng         published only after validation
 *     output/preview.jpg
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const INPUT_SLOTS = [0, 1, 2] as const;
export type InputSlot = (typeof INPUT_SLOTS)[number];

export function isJobId(value: string): boolean {
  return UUID_RE.test(value);
}

export function parseSlot(value: string): InputSlot | undefined {
  return value === "0" || value === "1" || value === "2" ? (Number(value) as InputSlot) : undefined;
}

export class JobPaths {
  readonly root: string;

  constructor(jobsDir: string, jobId: string) {
    if (!isJobId(jobId)) throw new Error("Invalid job id");
    this.root = path.join(jobsDir, jobId);
  }

  get inputsDir(): string {
    return path.join(this.root, "inputs");
  }

  get workDir(): string {
    return path.join(this.root, "work");
  }

  get outputDir(): string {
    return path.join(this.root, "output");
  }

  input(slot: InputSlot): string {
    return path.join(this.inputsDir, `input-${slot}.raw`);
  }

  get dng(): string {
    return path.join(this.outputDir, "merged.dng");
  }

  get jpeg(): string {
    return path.join(this.outputDir, "preview.jpg");
  }
}
