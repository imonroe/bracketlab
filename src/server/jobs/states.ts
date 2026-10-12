/**
 * Job lifecycle (PRD section F5).
 *
 * Happy path: uploading -> validating -> queued -> merging -> rendering_preview -> complete.
 * A preview failure keeps the DNG (raw_ready_preview_failed) and a retry re-queues only
 * the preview stage. Any remaining artifacts eventually move the job to expired.
 */
export const JOB_STATES = [
  "uploading",
  "validating",
  "queued",
  "merging",
  "rendering_preview",
  "complete",
  "raw_ready_preview_failed",
  "failed",
  "canceled",
  "expired",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** Which native stage a queued job runs next. */
export type JobStage = "merge" | "preview";

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  // Validation rejects go back to uploading so the user can replace files.
  uploading: ["validating", "canceled", "expired"],
  validating: ["queued", "uploading", "failed", "canceled"],
  queued: ["merging", "rendering_preview", "canceled", "expired"],
  merging: ["rendering_preview", "failed", "canceled"],
  rendering_preview: ["complete", "raw_ready_preview_failed", "failed", "canceled"],
  complete: ["expired"],
  raw_ready_preview_failed: ["queued", "expired"],
  // Retryable failures (for example a job interrupted by a restart) can be re-queued.
  failed: ["queued", "expired"],
  canceled: ["expired"],
  expired: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

/** States in which a native process may be running for the job. */
export const ACTIVE_STATES: readonly JobState[] = ["merging", "rendering_preview"];

/** States the user can cancel from. */
export const CANCELABLE_STATES: readonly JobState[] = [
  "uploading",
  "validating",
  "queued",
  "merging",
  "rendering_preview",
];

export function isActive(state: JobState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isCancelable(state: JobState): boolean {
  return CANCELABLE_STATES.includes(state);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`Cannot move job from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}
