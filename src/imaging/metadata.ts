import { runProcess } from "@/worker/process";
import type { ExposureInfo } from "./bracket";

/** The exposure fields of one file, without its position in a bracket. */
export type FileExposure = Omit<ExposureInfo, "index">;

interface ExifRecord {
  FileType?: string;
  Make?: string;
  Model?: string;
  ISO?: number;
  FNumber?: number;
  ExposureTime?: number;
  FocalLength?: number;
  DateTimeOriginal?: string;
}

const TAGS = ["FileType", "Make", "Model", "ISO", "FNumber", "ExposureTime", "FocalLength", "DateTimeOriginal"];

export interface ReadOptions {
  exiftool: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs: number;
}

export class MetadataUnreadableError extends Error {
  constructor(readonly stderr: string) {
    super("ExifTool returned no usable metadata");
    this.name = "MetadataUnreadableError";
  }
}

/**
 * Reads the bracket-relevant tags of each file with one ExifTool call. A file ExifTool
 * can't read comes back as an empty record (no fileType), which the bracket check
 * reports against that file.
 */
export async function readExposures(files: string[], options: ReadOptions): Promise<FileExposure[]> {
  // ExifTool exits 1 when any file fails but still prints a record for every file.
  const { stdout, stderr } = await runProcess(
    options.exiftool,
    ["-json", "-n", ...TAGS.map((t) => `-${t}`), "--", ...files],
    { env: options.env, signal: options.signal, timeoutMs: options.timeoutMs, okExitCodes: [0, 1] },
  );
  let records: ExifRecord[];
  try {
    records = JSON.parse(stdout) as ExifRecord[];
  } catch {
    records = [];
  }
  if (records.length !== files.length) throw new MetadataUnreadableError(stderr);

  return records.map((r) => ({
    fileType: r.FileType,
    make: r.Make,
    model: r.Model,
    iso: r.ISO,
    fNumber: r.FNumber,
    exposureTime: r.ExposureTime,
    focalLength: r.FocalLength,
    dateTimeOriginal: r.DateTimeOriginal,
  }));
}
