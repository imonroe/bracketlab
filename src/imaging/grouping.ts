import { checkBracket, checkFrame, parseExifDate, type BracketIssue, type BracketPolicy, type ExposureInfo } from "./bracket";
import type { FileExposure } from "./metadata";

/**
 * Matches a shoot's worth of RAW files into three-frame brackets.
 *
 * Files are sorted by capture time and split into consecutive triples. Every triple must
 * pass the same bracket check as a single upload (one camera, fixed ISO, aperture and
 * focal length, three distinct shutter speeds) and fit inside `maxSpanSeconds`. Among
 * all splits, the matcher picks the one that places the most files, and among those, the
 * one with the tightest sets. That keeps one stray frame (a test shot, a duplicate) from
 * shifting every set after it, and copes with both bracket-mode sets (fractions of a
 * second apart) and hand-bracketed ones (a few seconds apart). Files that fit no set are
 * returned as unplaced, with a reason.
 */

export interface MatchFile {
  id: string;
  name: string;
  exposure: FileExposure | null;
  /** Problems already known for this file, such as unreadable metadata or a duplicate. */
  issues: BracketIssue[];
}

export interface MatchedSet {
  /** Stable while the set's membership is unchanged; used to confirm a reviewed set. */
  key: string;
  /** In capture order. */
  fileIds: string[];
  /** Darkest to brightest, with EV offsets from the darkest. */
  order: { fileId: string; evOffset: number }[];
  /** Capture time of the first frame, in ms (camera clock, zone ignored). */
  startedAt: number;
  spanSeconds: number;
  warnings: BracketIssue[];
}

export interface UnplacedFile {
  fileId: string;
  reason: string;
}

export interface MatchResult {
  sets: MatchedSet[];
  unplaced: UnplacedFile[];
}

export interface MatchOptions {
  policy: BracketPolicy;
  /** Longest a set may take to shoot. Hand bracketing takes seconds; moving rooms, longer. */
  maxSpanSeconds?: number;
}

const DEFAULT_MAX_SPAN_SECONDS = 60;

const NO_FIT =
  "Couldn't be matched with the shots taken just before or after it. A set needs three shots of the same scene, with the same ISO, aperture and focal length, three different shutter speeds, taken within a minute.";

interface Candidate {
  file: MatchFile;
  frame: ExposureInfo;
  at: number;
}

export function matchBrackets(files: MatchFile[], options: MatchOptions): MatchResult {
  const maxSpan = options.maxSpanSeconds ?? DEFAULT_MAX_SPAN_SECONDS;
  const unplaced: UnplacedFile[] = [];
  const candidates: Candidate[] = [];

  files.forEach((file, index) => {
    if (file.issues.length > 0) {
      unplaced.push({ fileId: file.id, reason: file.issues.map((i) => i.message).join(" ") });
      return;
    }
    if (!file.exposure) {
      unplaced.push({ fileId: file.id, reason: `${file.name} hasn't been checked yet. Remove it and upload it again.` });
      return;
    }
    const frame: ExposureInfo = { ...file.exposure, index, label: file.name };
    const issues = checkFrame(frame, options.policy);
    if (issues.length > 0) {
      unplaced.push({ fileId: file.id, reason: issues.map((i) => i.message).join(" ") });
      return;
    }
    const at = parseExifDate(file.exposure.dateTimeOriginal);
    if (at === undefined) {
      unplaced.push({ fileId: file.id, reason: `${file.name} has no capture time, so it can't be matched with other shots.` });
      return;
    }
    candidates.push({ file, frame, at });
  });

  candidates.sort((a, b) => a.at - b.at || a.file.name.localeCompare(b.file.name));

  // best[i]: the best split of the first i candidates, as (sets placed, total span).
  // More sets wins; ties go to the smaller total span.
  type Best = { sets: number; span: number; tookSet: boolean };
  const best: Best[] = [{ sets: 0, span: 0, tookSet: false }];
  const better = (a: Best, b: Best) => a.sets > b.sets || (a.sets === b.sets && a.span < b.span);

  const tripleSpan = (end: number): number | null => {
    const triple = candidates.slice(end - 3, end);
    const span = (triple[2].at - triple[0].at) / 1000;
    if (span > maxSpan) return null;
    return checkBracket(triple.map((c) => c.frame), options.policy).errors.length === 0 ? span : null;
  };

  for (let i = 1; i <= candidates.length; i++) {
    let choice: Best = { ...best[i - 1], tookSet: false };
    if (i >= 3) {
      const span = tripleSpan(i);
      if (span !== null) {
        const withSet: Best = { sets: best[i - 3].sets + 1, span: best[i - 3].span + span, tookSet: true };
        if (better(withSet, choice)) choice = withSet;
      }
    }
    best.push(choice);
  }

  const sets: MatchedSet[] = [];
  for (let i = candidates.length; i > 0; ) {
    if (best[i].tookSet) {
      const triple = candidates.slice(i - 3, i);
      const check = checkBracket(triple.map((c) => c.frame), options.policy);
      sets.unshift({
        key: triple.map((c) => c.file.id).join(","),
        fileIds: triple.map((c) => c.file.id),
        order: check.order.map((index, n) => ({ fileId: files[index].id, evOffset: check.evOffsets[n] })),
        startedAt: triple[0].at,
        spanSeconds: Math.round(((triple[2].at - triple[0].at) / 1000) * 10) / 10,
        warnings: check.warnings,
      });
      i -= 3;
    } else {
      unplaced.push({ fileId: candidates[i - 1].file.id, reason: NO_FIT });
      i -= 1;
    }
  }

  return { sets, unplaced };
}
