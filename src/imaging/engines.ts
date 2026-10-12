import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { EngineError, type ImagingEngine } from "./engine";

/**
 * Default until the Phase 0 toolchain (HDRMerge + darktable-cli) lands. Jobs fail with
 * a clear message instead of pretending to merge.
 */
export class UnavailableEngine implements ImagingEngine {
  readonly name = "unavailable";

  async merge(): Promise<never> {
    throw new EngineError(
      "engine_unavailable",
      "The HDR merge engine isn't installed in this build yet.",
    );
  }

  async renderPreview(): Promise<never> {
    throw new EngineError(
      "engine_unavailable",
      "The preview renderer isn't installed in this build yet.",
    );
  }
}

// A 1x1 grey baseline JPEG, so the fake engine produces a file browsers can display.
const PLACEHOLDER_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k=",
  "base64",
);

/**
 * Development-only engine for exercising the web and worker flow without native tools.
 * The "DNG" is a copy of the first input and the preview is a placeholder. Never enable
 * this in a real deployment.
 */
export class FakeEngine implements ImagingEngine {
  readonly name = "fake";

  constructor(private readonly stageDelayMs = 1500) {}

  async merge({ inputs, output, signal }: Parameters<ImagingEngine["merge"]>[0]) {
    await delay(this.stageDelayMs, undefined, { signal });
    await fsp.copyFile(inputs[0], output);
    return { engine: { name: this.name } };
  }

  async renderPreview({ output, signal }: Parameters<ImagingEngine["renderPreview"]>[0]) {
    await delay(this.stageDelayMs, undefined, { signal });
    await fsp.writeFile(output, PLACEHOLDER_JPEG);
  }
}

export function engineFromEnv(): ImagingEngine {
  const name = process.env.BRACKETLAB_ENGINE ?? "unavailable";
  switch (name) {
    case "unavailable":
      return new UnavailableEngine();
    case "fake":
      return new FakeEngine(Number(process.env.BRACKETLAB_FAKE_DELAY_MS ?? 1500));
    default:
      throw new Error(`Unknown BRACKETLAB_ENGINE "${name}"`);
  }
}
