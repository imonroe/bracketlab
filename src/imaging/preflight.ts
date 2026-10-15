import type { JobInput } from "@/server/jobs/store";
import { checkBracket, checkFrame, type BracketIssue, type BracketPolicy, type ExposureInfo } from "./bracket";

export type PreflightIssue = BracketIssue;

export interface Preflight {
  /** True once all three slots hold a file. */
  complete: boolean;
  /** Anything that blocks Merge. */
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  /** Issues that belong to one file, keyed by slot, so the page can show them in place. */
  byInput: Record<number, PreflightIssue[]>;
  /** Slots ordered dark to bright, with EV offsets, once the bracket checks out. */
  order: { slot: number; evOffset: number }[] | null;
}

/**
 * Everything that can be checked before Merge, from the upload records and the exposure
 * metadata read at upload time (PRD F2). With no policy, metadata reading is off (the
 * fake and unavailable engines) and only the structural checks run.
 */
export function preflight(inputs: JobInput[], policy: BracketPolicy | null): Preflight {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const byInput: Record<number, PreflightIssue[]> = {};
  const flag = (slot: number, issue: PreflightIssue) => {
    (byInput[slot] ??= []).push(issue);
    errors.push(issue);
  };
  const complete = inputs.length === 3;

  for (const input of inputs) {
    if (input.bytes === 0) flag(input.slot, { code: "empty_input", message: `File ${input.slot + 1} is empty.` });
  }

  const seen = new Map<string, number>();
  for (const input of inputs) {
    const other = seen.get(input.sha256);
    if (other !== undefined) {
      flag(input.slot, {
        code: "duplicate_input",
        message: `Files ${other + 1} and ${input.slot + 1} are identical. Upload three different exposures.`,
      });
    }
    seen.set(input.sha256, input.slot);
  }

  let order: Preflight["order"] = null;
  if (policy) {
    const frames: ExposureInfo[] = [];
    for (const input of inputs) {
      if (input.metadataError) {
        flag(input.slot, {
          code: "metadata_unreadable",
          message: `File ${input.slot + 1} couldn't be read. It may be damaged or not a RAW file.`,
        });
        continue;
      }
      if (!input.exposure) {
        // Uploaded before checks were turned on (an older version, or another engine).
        flag(input.slot, {
          code: "metadata_unchecked",
          message: `File ${input.slot + 1} hasn't been checked yet. Replace it to check it.`,
        });
        continue;
      }
      const frame = { ...input.exposure, index: input.slot };
      for (const issue of checkFrame(frame, policy)) flag(input.slot, issue);
      frames.push(frame);
    }

    if (complete && errors.length === 0) {
      const bracket = checkBracket(frames, policy);
      errors.push(...bracket.errors);
      warnings.push(...bracket.warnings);
      if (bracket.errors.length === 0) {
        order = bracket.order.map((slot, i) => ({ slot, evOffset: bracket.evOffsets[i] }));
      }
    }
  }

  if (!complete) {
    errors.push({
      code: "wrong_count",
      message: `A bracket needs exactly three files; ${inputs.length} uploaded.`,
    });
  }

  return { complete, errors, warnings, byInput, order };
}
