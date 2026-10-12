/**
 * Bracket checks from PRD F2, run on ExifTool metadata before HDRMerge. HDRMerge stays
 * authoritative: passing here does not guarantee it accepts the files.
 */

export interface ExposureInfo {
  /** Index into the input list, so results can be mapped back to slots. */
  index: number;
  fileType?: string;
  make?: string;
  model?: string;
  iso?: number;
  fNumber?: number;
  /** Seconds. */
  exposureTime?: number;
  focalLength?: number;
  /** ExifTool format, "YYYY:MM:DD HH:MM:SS". */
  dateTimeOriginal?: string;
}

export interface BracketIssue {
  code: string;
  message: string;
}

export interface BracketCheck {
  errors: BracketIssue[];
  warnings: BracketIssue[];
  /** Input indexes from darkest (shortest exposure) to brightest. */
  order: number[];
  /** Exposure of each ordered frame in EV relative to the darkest, e.g. [0, 2, 4]. */
  evOffsets: number[];
}

export interface BracketPolicy {
  /** Camera models accepted, as ExifTool reports them. "*" accepts any model. */
  supportedModels: string[];
  /** Warn when the frames span more than this many seconds. */
  maxCaptureSpanSeconds: number;
}

export const DEFAULT_POLICY: BracketPolicy = {
  supportedModels: ["ILCE-6100"],
  maxCaptureSpanSeconds: 30,
};

/** The policy both the web process and the worker use, from BRACKETLAB_SUPPORTED_MODELS. */
export function bracketPolicyFromEnv(env: Record<string, string | undefined> = process.env): BracketPolicy {
  const models = env.BRACKETLAB_SUPPORTED_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return { ...DEFAULT_POLICY, supportedModels: models?.length ? models : DEFAULT_POLICY.supportedModels };
}

const RAW_TYPES = new Set(["ARW"]);

function frame(i: number): string {
  return `File ${i + 1}`;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Values equal within a relative tolerance, so 3.5 and 3.4999 count as the same aperture. */
function allClose(values: number[], tolerance = 0.01): boolean {
  return values.every((v) => Math.abs(v - values[0]) <= Math.abs(values[0]) * tolerance);
}

function parseExifDate(value: string | undefined): number | undefined {
  const m = value?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

export function formatShutter(seconds: number): string {
  return seconds >= 0.5 ? `${Number(seconds.toFixed(1))}s` : `1/${Math.round(1 / seconds)}s`;
}

/**
 * Problems with one file on its own, so the page can flag a file as soon as it uploads.
 * Each issue names the file it belongs to.
 */
export function checkFrame(f: ExposureInfo, policy: BracketPolicy = DEFAULT_POLICY): BracketIssue[] {
  if (!f.fileType || !RAW_TYPES.has(f.fileType.toUpperCase())) {
    return [
      {
        code: "unsupported_format",
        message: `${frame(f.index)} isn't a supported RAW file${f.fileType ? ` (it looks like ${f.fileType})` : ""}. Upload Sony ARW files.`,
      },
    ];
  }
  const issues: BracketIssue[] = [];
  const model = f.model ?? "";
  if (!policy.supportedModels.includes("*") && !policy.supportedModels.includes(model)) {
    issues.push({
      code: "unsupported_camera",
      message: `${frame(f.index)} comes from ${model || "an unknown camera"}, which hasn't been tested with BracketLab yet. Supported: ${policy.supportedModels.join(", ")}.`,
    });
  }
  if (f.exposureTime === undefined || f.iso === undefined || f.fNumber === undefined) {
    issues.push({
      code: "missing_exposure",
      message: `${frame(f.index)} is missing its shutter speed, ISO or aperture, so the exposures can't be ordered.`,
    });
  }
  return issues;
}

export function checkBracket(frames: ExposureInfo[], policy: BracketPolicy = DEFAULT_POLICY): BracketCheck {
  const errors: BracketIssue[] = [];
  const warnings: BracketIssue[] = [];
  const result = (order: number[] = [], evOffsets: number[] = []) => ({ errors, warnings, order, evOffsets });

  if (frames.length !== 3) {
    errors.push({ code: "wrong_count", message: `A bracket needs exactly three files; got ${frames.length}.` });
    return result();
  }

  for (const f of frames) errors.push(...checkFrame(f, policy));
  if (errors.length > 0) return result();

  const models = distinct(frames.map((f) => `${f.make ?? ""} ${f.model ?? ""}`.trim()));
  if (models.length > 1) {
    errors.push({ code: "mixed_cameras", message: `The files come from different cameras (${models.join(", ")}).` });
    return result();
  }

  if (!allClose(frames.map((f) => f.iso!))) {
    errors.push({
      code: "iso_differs",
      message: `ISO differs between files (${frames.map((f) => f.iso).join(", ")}). Keep ISO fixed and vary only the shutter speed.`,
    });
  }
  if (!allClose(frames.map((f) => f.fNumber!))) {
    errors.push({
      code: "aperture_differs",
      message: `Aperture differs between files (${frames.map((f) => `f/${f.fNumber}`).join(", ")}). Keep the aperture fixed.`,
    });
  }
  const focal = frames.map((f) => f.focalLength).filter((v): v is number => v !== undefined);
  if (focal.length === frames.length && !allClose(focal)) {
    errors.push({
      code: "focal_length_differs",
      message: `Focal length differs between files (${focal.map((v) => `${v}mm`).join(", ")}). Don't zoom between shots.`,
    });
  }

  const order = [...frames].sort((a, b) => a.exposureTime! - b.exposureTime!).map((f) => f.index);
  const times = order.map((i) => frames.find((f) => f.index === i)!.exposureTime!);
  const evOffsets = times.map((t) => Math.round(Math.log2(t / times[0]) * 10) / 10);
  for (let i = 1; i < evOffsets.length; i++) {
    if (evOffsets[i] - evOffsets[i - 1] < 0.3) {
      errors.push({
        code: "exposures_not_distinct",
        message: `Two files have the same shutter speed (${formatShutter(times[i])}). A bracket needs three different exposures.`,
      });
      break;
    }
  }
  if (errors.length > 0) return result(order, evOffsets);

  const stamps = frames.map((f) => parseExifDate(f.dateTimeOriginal));
  if (stamps.every((s): s is number => s !== undefined)) {
    const span = (Math.max(...stamps) - Math.min(...stamps)) / 1000;
    if (span > policy.maxCaptureSpanSeconds) {
      warnings.push({
        code: "capture_gap",
        message: `The shots were taken ${Math.round(span)} seconds apart. Light or subjects may have changed between them.`,
      });
    }
  }

  return result(order, evOffsets);
}
