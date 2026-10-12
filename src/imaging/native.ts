import fsp from "node:fs/promises";
import path from "node:path";
import { ProcessError, runProcess } from "@/worker/process";
import { checkBracket, type BracketPolicy, type ExposureInfo } from "./bracket";
import { EngineError, type ImagingEngine, type MergeRequest, type MergeResult, type PreviewRequest } from "./engine";

/**
 * The real pipeline: ExifTool for bracket checks, HDRMerge for the RAW-domain merge into
 * a floating-point DNG, darktable-cli for the JPEG preview.
 */

export interface NativeEngineOptions {
  hdrmerge: string;
  darktableCli: string;
  exiftool: string;
  policy: BracketPolicy;
  /** Recorded in the job manifest. */
  versions: Record<string, string>;
}

/** PRD section 3: 16-bit float samples; no embedded preview in the DNG. */
const HDRMERGE_ARGS = ["-vv", "-p", "none", "-b", "16"];
const PREVIEW_MAX_PX = 2560;
const PREVIEW_QUALITY = 90;

/** Engine failure that also carries tool output for the worker log, never for the user. */
export class NativeEngineError extends EngineError {
  constructor(
    code: string,
    userMessage: string,
    readonly logDetail?: string,
    options?: { cause?: unknown },
  ) {
    super(code, userMessage, options);
  }
}

/**
 * Each native process gets its own scratch HOME inside the job's work directory. The
 * service user has no home, and Qt, fontconfig and darktable all need somewhere to write.
 * Nothing else from the worker's environment is passed through.
 */
async function toolEnv(workDir: string): Promise<Record<string, string | undefined>> {
  const home = path.join(workDir, "home");
  const runtime = path.join(home, "run");
  await fsp.mkdir(runtime, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    LANG: "C.UTF-8",
    // HDRMerge links Qt Widgets and aborts without a platform plugin, even in CLI mode.
    QT_QPA_PLATFORM: "offscreen",
  };
}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : text.slice(-max);
}

/** Converts a process failure into an engine error. Cancellation passes through untouched. */
function asEngineError(error: unknown, stage: "merge" | "preview", timeoutMs: number): unknown {
  if (!(error instanceof ProcessError) || error.reason === "aborted") return error;
  const minutes = Math.round(timeoutMs / 60000);
  if (error.reason === "timeout") {
    return new NativeEngineError(
      `${stage}_timeout`,
      `The ${stage === "merge" ? "merge" : "preview"} took longer than ${minutes} minutes and was stopped.`,
      tail(error.stderr),
      { cause: error },
    );
  }
  return new NativeEngineError(
    `${stage}_failed`,
    stage === "merge"
      ? "HDRMerge couldn't merge these files."
      : "darktable couldn't render a preview from the merged DNG.",
    `${error.message}\n${tail(error.stderr)}`,
    { cause: error },
  );
}

interface ExifRecord {
  FileType?: string;
  Make?: string;
  Model?: string;
  ISO?: number;
  FNumber?: number;
  ExposureTime?: number;
  FocalLength?: number;
  DateTimeOriginal?: string;
  SampleFormat?: number | number[];
  PhotometricInterpretation?: number;
  DNGVersion?: string;
}

export class NativeEngine implements ImagingEngine {
  readonly name = "native";

  constructor(private readonly options: NativeEngineOptions) {}

  private async exif(files: string[], tags: string[], env: Record<string, string | undefined>, signal: AbortSignal, timeoutMs: number): Promise<ExifRecord[]> {
    // Exit 1 means at least one file couldn't be read; its record then has no tags, which
    // the bracket check reports per file.
    const { stdout, stderr } = await runProcess(
      this.options.exiftool,
      ["-json", "-n", ...tags.map((t) => `-${t}`), "--", ...files],
      { env, signal, timeoutMs, okExitCodes: [0, 1] },
    );
    let records: ExifRecord[];
    try {
      records = JSON.parse(stdout) as ExifRecord[];
    } catch {
      records = [];
    }
    if (records.length !== files.length) {
      throw new NativeEngineError("metadata_unreadable", "BracketLab couldn't read the files' metadata.", tail(stderr));
    }
    return records;
  }

  async merge({ inputs, output, workDir, signal, timeoutMs }: MergeRequest): Promise<MergeResult> {
    const env = await toolEnv(workDir);

    let records: ExifRecord[];
    try {
      records = await this.exif(
        inputs,
        ["FileType", "Make", "Model", "ISO", "FNumber", "ExposureTime", "FocalLength", "DateTimeOriginal"],
        env,
        signal,
        timeoutMs,
      );
    } catch (error) {
      throw asEngineError(error, "merge", timeoutMs);
    }

    const frames: ExposureInfo[] = records.map((r, index) => ({
      index,
      fileType: r.FileType,
      make: r.Make,
      model: r.Model,
      iso: r.ISO,
      fNumber: r.FNumber,
      exposureTime: r.ExposureTime,
      focalLength: r.FocalLength,
      dateTimeOriginal: r.DateTimeOriginal,
    }));
    const bracket = checkBracket(frames, this.options.policy);
    if (bracket.errors.length > 0) {
      throw new NativeEngineError(bracket.errors[0].code, bracket.errors.map((e) => e.message).join(" "));
    }

    let run;
    try {
      run = await runProcess(
        this.options.hdrmerge,
        [...HDRMERGE_ARGS, "-o", output, ...bracket.order.map((i) => inputs[i])],
        { env, signal, timeoutMs, cwd: workDir },
      );
    } catch (error) {
      throw asEngineError(error, "merge", timeoutMs);
    }

    // HDRMerge exits 0 even when it rejects its inputs; the only reliable signal is
    // whether it wrote a valid DNG.
    const log = `${run.stdout}\n${run.stderr}`;
    await this.validateDng(output, env, signal, timeoutMs, log);

    const frame = (i: number) => frames[i];
    return {
      engine: { name: this.name, ...this.options.versions },
      details: {
        exposures: bracket.order.map((i, n) => ({
          slot: i,
          exposureTime: frame(i).exposureTime,
          evOffset: bracket.evOffsets[n],
        })),
        iso: frame(0).iso,
        fNumber: frame(0).fNumber,
        focalLength: frame(0).focalLength,
        model: frame(0).model,
        warnings: bracket.warnings,
        alignment: parseAlignment(run.stdout),
        whiteLevel: Number(run.stdout.match(/Using white level (\d+)/)?.[1]) || undefined,
        options: { bitsPerSample: 16, embeddedPreview: false, align: true, crop: true },
      },
    };
  }

  private async validateDng(
    file: string,
    env: Record<string, string | undefined>,
    signal: AbortSignal,
    timeoutMs: number,
    hdrmergeLog: string,
  ): Promise<void> {
    // HDRMerge's only load errors (Launcher.cpp). It reports any decode failure as
    // "file not found", and exits 0 either way because of a shadowed result variable.
    if (/^Error loading .*, it has a different format\./m.test(hdrmergeLog)) {
      throw new NativeEngineError(
        "inputs_mismatched",
        "HDRMerge found that one file doesn't match the others. All three need the same camera, image size and RAW mode.",
        tail(hdrmergeLog),
      );
    }
    if (/^Error loading .*, file not found\./m.test(hdrmergeLog)) {
      throw new NativeEngineError(
        "input_unreadable",
        "HDRMerge couldn't read one of the files. It may be damaged or not a supported RAW file.",
        tail(hdrmergeLog),
      );
    }
    try {
      await fsp.access(file);
    } catch {
      throw new NativeEngineError("merge_failed", "HDRMerge finished without writing a DNG.", tail(hdrmergeLog));
    }

    let record: ExifRecord | undefined;
    try {
      [record] = await this.exif([file], ["DNGVersion", "SampleFormat", "PhotometricInterpretation"], env, signal, timeoutMs);
    } catch (error) {
      throw asEngineError(error, "merge", timeoutMs);
    }
    const formats = ([] as number[]).concat(record?.SampleFormat ?? []);
    // SampleFormat 3 is IEEE float; 32803 is CFA (mosaic) data, i.e. still RAW.
    if (!record?.DNGVersion || !formats.includes(3) || record.PhotometricInterpretation !== 32803) {
      throw new NativeEngineError(
        "invalid_output",
        "The merge produced a file that isn't a floating-point RAW DNG.",
        JSON.stringify(record),
      );
    }
  }

  async renderPreview({ dng, output, workDir, signal, timeoutMs }: PreviewRequest): Promise<void> {
    const env = await toolEnv(workDir);
    const dt = path.join(workDir, "darktable");
    await fsp.mkdir(path.join(dt, "config"), { recursive: true });
    await fsp.mkdir(path.join(dt, "cache"), { recursive: true });

    try {
      // A fixed recipe with an isolated, throwaway configuration, so the preview never
      // depends on anyone's darktable settings (PRD F4).
      await runProcess(
        this.options.darktableCli,
        [
          dng,
          output,
          "--width", String(PREVIEW_MAX_PX),
          "--height", String(PREVIEW_MAX_PX),
          "--hq", "true",
          "--upscale", "false",
          "--apply-custom-presets", "false",
          "--core",
          "--configdir", path.join(dt, "config"),
          "--cachedir", path.join(dt, "cache"),
          "--library", ":memory:",
          "--disable-opencl",
          "--conf", `plugins/imageio/format/jpeg/quality=${PREVIEW_QUALITY}`,
          "--conf", "write_sidecar_files=never",
        ],
        { env, signal, timeoutMs, cwd: workDir },
      );

      // PRD section 10: the JPEG keeps only what displays it correctly. This drops camera
      // serial numbers, GPS and other identifying tags.
      await runProcess(
        this.options.exiftool,
        ["-overwrite_original", "-all=", "-tagsFromFile", "@", "-ICC_Profile", "-ColorSpaceTags", "-Orientation", "--", output],
        { env, signal, timeoutMs },
      );
    } catch (error) {
      throw asEngineError(error, "preview", timeoutMs);
    }
  }
}

export function parseAlignment(stdout: string): { image: number; dx: number; dy: number; error: number }[] {
  return [...stdout.matchAll(/Image (\d+) displaced to \((-?\d+), (-?\d+)\) with error ([\d.eE+-]+)/g)].map(
    (m) => ({ image: Number(m[1]), dx: Number(m[2]), dy: Number(m[3]), error: Number(m[4]) }),
  );
}
