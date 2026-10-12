import type { JobInput } from "@/server/jobs/store";

export interface PreflightIssue {
  code: string;
  message: string;
}

export interface PreflightResult {
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
}

/**
 * Checks that can run on upload records alone. The metadata checks from PRD F2 (decodable
 * format, camera model, RAW mode, ISO/aperture, exposure ordering) need ExifTool and a
 * decoder in the container and belong here once the Phase 0 toolchain exists.
 */
export function structuralPreflight(inputs: JobInput[]): PreflightResult {
  const errors: PreflightIssue[] = [];

  if (inputs.length !== 3) {
    errors.push({
      code: "wrong_count",
      message: `A bracket needs exactly three files; ${inputs.length} uploaded.`,
    });
  }

  const seen = new Map<string, number>();
  for (const input of inputs) {
    const other = seen.get(input.sha256);
    if (other !== undefined) {
      errors.push({
        code: "duplicate_input",
        message: `Files ${other + 1} and ${input.slot + 1} are identical. Upload three different exposures.`,
      });
    }
    seen.set(input.sha256, input.slot);
  }

  for (const input of inputs) {
    if (input.bytes === 0) {
      errors.push({ code: "empty_input", message: `File ${input.slot + 1} is empty.` });
    }
  }

  return { errors, warnings: [] };
}
