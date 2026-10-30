import { foldForDetection } from './fold';

/*
 * The working text of one redaction pass.
 *
 * Rules read and rewrite the *detection view* of a string (see `fold.ts`), but the string that is
 * returned must be the author's original text with only the redacted spans replaced. A `Rewriter`
 * holds both: the working view the rules operate on, and (when the view differs from the original) a
 * list of regions that records which stretch of the view each replacement stands for. At the end
 * `finish()` writes every region's replacement text over the matching span of the original and copies
 * everything else, including invisible characters between and next to the spans, unchanged.
 *
 * When the view equals the original (plain text) there is nothing to track and the rewriter is a thin
 * wrapper around `String.prototype.replace`, which is exactly what the rules did before.
 */

/** A `String.prototype.replace` callback: `(match, ...groups, offset, whole)`. */
export type Replacer = (substring: string, ...args: never[]) => string;

export interface RewriterOptions {
  /** Tests only: track provenance even when the text needs no folding. */
  readonly forceTracking?: boolean;
}

/**
 * Merges edits into a region list.
 *
 * `regions` holds quadruples `[workStart, workEnd, foldStart, foldEnd]` in ascending order: the working
 * text between `workStart` and `workEnd` is a replacement for the folded characters
 * `[foldStart, foldEnd)`. The edits (`start[k]`..`end[k]` replaced by `length[k]` characters) are in
 * the coordinates of the working text before the edit, ascending and disjoint.
 *
 * An edit that overlaps an existing region absorbs it (the new region then covers both folded ranges),
 * and edits that overlap each other form one region. Edits that merely touch stay separate.
 */
export function mergeEdits(
  regions: readonly number[],
  start: readonly number[],
  end: readonly number[],
  length: readonly number[],
): number[] {
  const out: number[] = [];
  const regionCount = regions.length >> 2;
  let next = 0; // next old region
  let shift = 0; // net length change of the edits already emitted
  // Working-minus-folded offset of the stretch of untouched characters that follows the last region
  // passed: every character there has folded index `workIndex - gap`.
  let gap = 0;

  const copy = (index: number): void => {
    out.push(
      (regions[4 * index] ?? 0) + shift,
      (regions[4 * index + 1] ?? 0) + shift,
      regions[4 * index + 2] ?? 0,
      regions[4 * index + 3] ?? 0,
    );
  };

  let k = 0;
  while (k < start.length) {
    const first = start[k] ?? 0;
    let right = end[k] ?? 0;
    let delta = (length[k] ?? 0) - (right - first);

    while (next < regionCount && (regions[4 * next + 1] ?? 0) <= first) {
      copy(next);
      gap = (regions[4 * next + 1] ?? 0) - (regions[4 * next + 3] ?? 0);
      next += 1;
    }
    let left = first;
    if (next < regionCount && (regions[4 * next] ?? 0) < first) left = regions[4 * next] ?? first;
    const foldStart = left - gap;

    let tailGap = gap;
    for (;;) {
      while (next < regionCount && (regions[4 * next] ?? 0) < right) {
        const regionEnd = regions[4 * next + 1] ?? 0;
        if (regionEnd > right) right = regionEnd;
        tailGap = regionEnd - (regions[4 * next + 3] ?? 0);
        next += 1;
      }
      if (k + 1 < start.length && (start[k + 1] ?? 0) < right) {
        k += 1;
        right = Math.max(right, end[k] ?? 0);
        delta += (length[k] ?? 0) - ((end[k] ?? 0) - (start[k] ?? 0));
        continue;
      }
      break;
    }

    out.push(left + shift, right + shift + delta, foldStart, right - tailGap);
    shift += delta;
    gap = tailGap;
    k += 1;
  }
  while (next < regionCount) {
    copy(next);
    next += 1;
  }
  return out;
}

export class Rewriter {
  private readonly source: string;
  private readonly starts: Int32Array | null;
  private working: string;
  private regions: number[] = [];

  constructor(source: string, options: RewriterOptions = {}) {
    this.source = source;
    const folded = foldForDetection(source);
    if (folded !== null) {
      this.working = folded.text;
      this.starts = folded.starts;
    } else if (options.forceTracking === true) {
      this.working = source;
      const identity = new Int32Array(source.length + 1);
      for (let i = 0; i <= source.length; i += 1) identity[i] = i;
      this.starts = identity;
    } else {
      this.working = source;
      this.starts = null;
    }
  }

  /** The text the rules read: the detection view, with replacements made so far. */
  get text(): string {
    return this.working;
  }

  /** True when the view differs from the original and replacements are tracked back to it. */
  get tracked(): boolean {
    return this.starts !== null;
  }

  /** `String.prototype.replace` on the working text, remembering what each replacement covered. */
  replace(pattern: RegExp, replacer: Replacer): void {
    this.rewrite(pattern, replacer, false);
  }

  /**
   * Like `replace`, for patterns whose first capture group is context that the replacement repeats
   * unchanged (`keyword: ` before a secret value). Only what follows that prefix counts as replaced,
   * so the prefix keeps its original characters (a no-break space after the colon, a zero-width
   * character inside the keyword) instead of the folded ones the rule saw.
   */
  replaceAfterPrefix(pattern: RegExp, replacer: Replacer): void {
    this.rewrite(pattern, replacer, true);
  }

  private rewrite(pattern: RegExp, replacer: Replacer, keepPrefix: boolean): void {
    if (this.starts === null) {
      this.working = this.working.replace(pattern, replacer as (...args: string[]) => string);
      return;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    const lengths: number[] = [];
    const next = this.working.replace(pattern, (...args: unknown[]): string => {
      const matched = args[0] as string;
      const replacement = (replacer as (...values: unknown[]) => string)(...args);
      if (replacement !== matched) {
        const tail = args[args.length - 1];
        const offset = args[args.length - (typeof tail === 'string' ? 2 : 3)] as number;
        const prefix = keepPrefix && typeof args[1] === 'string' ? args[1] : '';
        const kept = replacement.startsWith(prefix) ? prefix.length : 0;
        starts.push(offset + kept);
        ends.push(offset + matched.length);
        lengths.push(replacement.length - kept);
      }
      return replacement;
    });
    if (starts.length === 0) return;
    this.regions = mergeEdits(this.regions, starts, ends, lengths);
    this.working = next;
  }

  /**
   * Replaces ascending, disjoint spans of the working text with `replacement`. `spans` is a flat list
   * `[start, length, start, length, ...]` in working-text coordinates.
   */
  replaceSpans(spans: ArrayLike<number>, replacement: string): void {
    const count = spans.length >> 1;
    if (count === 0) return;
    const starts: number[] = [];
    const ends: number[] = [];
    const lengths: number[] = [];
    let out = '';
    let cursor = 0;
    for (let k = 0; k < count; k += 1) {
      const start = spans[2 * k] ?? 0;
      const end = start + (spans[2 * k + 1] ?? 0);
      out += this.working.slice(cursor, start) + replacement;
      cursor = end;
      starts.push(start);
      ends.push(end);
      lengths.push(replacement.length);
    }
    out += this.working.slice(cursor);
    if (this.starts !== null) this.regions = mergeEdits(this.regions, starts, ends, lengths);
    this.working = out;
  }

  /** The original string with every replacement written over the span it stands for. */
  finish(): string {
    const starts = this.starts;
    if (starts === null) return this.working;
    if (this.regions.length === 0) return this.source;
    let out = '';
    let cursor = 0;
    for (let r = 0; r < this.regions.length; r += 4) {
      const workStart = this.regions[r] ?? 0;
      const workEnd = this.regions[r + 1] ?? 0;
      const foldStart = this.regions[r + 2] ?? 0;
      const foldEnd = this.regions[r + 3] ?? 0;
      const from = starts[foldStart] ?? 0;
      if (from > cursor) out += this.source.slice(cursor, from);
      out += this.working.slice(workStart, workEnd);
      cursor = Math.max(cursor, this.sourceEnd(starts, foldEnd - 1));
    }
    return out + this.source.slice(cursor);
  }

  /** Offset just past the original character that produced folded index `index`. */
  private sourceEnd(starts: Int32Array, index: number): number {
    const start = starts[index] ?? 0;
    const unit = this.source.charCodeAt(start);
    if (unit >= 0xd800 && unit <= 0xdbff && start + 1 < this.source.length) {
      const next = this.source.charCodeAt(start + 1);
      if (next >= 0xdc00 && next <= 0xdfff) return start + 2;
    }
    return start + 1;
  }
}
