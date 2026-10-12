/**
 * Boundary between the worker and the native imaging tools. The worker owns job state,
 * cancellation and publishing; an engine only turns files into files inside the
 * scratch directory it is given.
 */

export interface MergeRequest {
  /** Input RAW files in slot order. The engine is responsible for exposure ordering. */
  inputs: string[];
  /** Where to write the merged DNG. The worker validates and publishes it afterwards. */
  output: string;
  workDir: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface MergeResult {
  /** Engine name and version details recorded in the job manifest. */
  engine: Record<string, string>;
  /** Any diagnostics the engine actually exposes. Do not invent values. */
  details?: Record<string, unknown>;
}

export interface PreviewRequest {
  dng: string;
  output: string;
  workDir: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ImagingEngine {
  readonly name: string;
  merge(request: MergeRequest): Promise<MergeResult>;
  renderPreview(request: PreviewRequest): Promise<void>;
}

/**
 * A failure with a message that is safe and useful to show the user. Anything else that
 * an engine throws is logged and replaced with a generic message.
 */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "EngineError";
  }
}
