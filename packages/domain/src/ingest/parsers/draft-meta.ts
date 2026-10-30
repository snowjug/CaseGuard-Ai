import { createHash } from 'node:crypto';
import { DEFAULT_WORKLOAD, type ResolvedOptions } from './options';
import type { AssembleInput, DraftEvent } from './draft-types';
import { safeSlice, codePointLength, type WarningCollector } from './text';

export const DEFAULT_PRODUCT = 'Unspecified product';
const FUTURE_TOLERANCE_MS = 24 * 3_600_000;
const REFERENCE = /^[A-Z0-9][A-Z0-9-]{3,39}$/;

/** First few source positions, for messages such as "(source 4, 9, 12, …)". */
export function sourceList(positions: readonly number[], max = 5): string {
  const shown = positions.slice(0, max).join(', ');
  return positions.length > max ? `${shown}, …` : shown;
}

function normaliseReference(value: string): string | null {
  const cleaned = value
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return REFERENCE.test(cleaned) ? cleaned : null;
}

export function syntheticNoticeFor(options: ResolvedOptions): string | undefined {
  if (!options.synthetic) return undefined;
  return safeSlice(
    options.syntheticNotice ??
      'SYNTHETIC DEMONSTRATION DATA. Drafted from text supplied as synthetic; all organisations, people, users, addresses and incidents are fictional.',
    500,
  );
}

export function pickTitle(
  options: ResolvedOptions,
  input: AssembleInput,
  defaulted: string[],
  warnings: WarningCollector,
): string {
  const candidate = options.title ?? input.header.title ?? input.derivedTitle;
  const title = (candidate ?? '').trim().replace(/\s+/g, ' ');
  // The schema counts code points, so astral characters must not make a short title look long enough.
  if (codePointLength(title) >= 5) {
    if (title.length > 200) {
      warnings.add(
        'title_truncated',
        'info',
        'The case title was longer than 200 characters and was cut.',
      );
      return `${safeSlice(title, 199)}…`;
    }
    return title;
  }
  defaulted.push('title');
  return input.source === 'csv' ? 'Imported case events' : 'Pasted case transcript';
}

/** The reference the caller or the text itself states; null when the draft has to name itself. */
export function statedReference(
  options: ResolvedOptions,
  input: AssembleInput,
  warnings: WarningCollector,
): string | null {
  if (options.reference) return options.reference;
  if (input.header.reference) {
    const cleaned = normaliseReference(input.header.reference);
    if (cleaned) return cleaned;
    warnings.add(
      'header_ignored',
      'info',
      'The case reference in the text is not usable (4-40 characters of A-Z, 0-9 and dashes); a generated reference was used.',
    );
  }
  return null;
}

/**
 * The name a draft gives itself: `CG-DRAFT-` and eight hex digits of a digest of the input text and
 * of the whole draft with an empty reference. Everything that feeds the content therefore feeds the
 * reference too (the date a time-only stamp was given, the case details passed with the text), so
 * identical input gives an identical reference and content that differs never keeps one it already
 * had; hashing the text alone left the same reference on a different case the next day.
 */
export function generatedReference(input: AssembleInput, unnamedDraft: unknown): string {
  const digest = createHash('sha256')
    .update(input.referenceSeed, 'utf8')
    .update('\u0000')
    .update(JSON.stringify(unnamedDraft), 'utf8')
    .digest('hex');
  return `CG-DRAFT-${digest.slice(0, 8).toUpperCase()}`;
}

export function dedupeTags(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const tag = safeSlice(raw.trim(), 40);
    if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 20) break;
  }
  return out;
}

export function workloadWarning(warnings: WarningCollector): void {
  warnings.add(
    'workload_assumed',
    'warning',
    `No workload was supplied; "${DEFAULT_WORKLOAD}" (the only built-in knowledge pack) was assumed.`,
    { hint: 'Pass the workload explicitly; analysis quality depends on it being right.' },
  );
}

function zoneName(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${offsetMinutes < 0 ? '-' : '+'}${hours}:${minutes}`;
}

/** Aggregated warnings about how timestamps were obtained (one message per kind, never per event). */
export function addTimestampWarnings(
  events: readonly DraftEvent[],
  options: ResolvedOptions,
  warnings: WarningCollector,
): void {
  const assumed = events.filter((e) => e.zoneAssumed);
  if (assumed.length > 0) {
    warnings.add(
      'timezone_assumed',
      'warning',
      `${assumed.length} of ${events.length} timestamp(s) do not state a time zone; ${zoneName(options.assumedOffsetMinutes)} was assumed.`,
      {
        hint: 'Write times with a zone, for example 2026-03-09T09:12:00Z or 09:12 UTC.',
        count: assumed.length,
      },
    );
  }
  const inherited = events.filter((e) => e.timestampBasis === 'inherited');
  if (inherited.length > 0) {
    warnings.add(
      'timestamp_inherited',
      'warning',
      `${inherited.length} message(s) have no usable timestamp and take the time of the nearest stamped message (source ${sourceList(inherited.map((e) => e.at))}).`,
      {
        hint: 'Add a timestamp to each message so durations are accurate.',
        count: inherited.length,
      },
    );
  }
  const rollovers = events.filter((e) => e.timestampBasis === 'rollover');
  if (rollovers.length > 0) {
    warnings.add(
      'date_rollover_assumed',
      'warning',
      `${rollovers.length} time-only stamp(s) went backwards past midnight and were placed on the next day.`,
      { hint: 'Add a date line or full timestamps to remove the guess.', count: rollovers.length },
    );
  }
  const future = events.filter((e) => e.timestampMs > options.nowMs + FUTURE_TOLERANCE_MS);
  if (future.length > 0) {
    warnings.add(
      'timestamp_in_future',
      'warning',
      `${future.length} event(s) are dated after the current time (${options.now}).`,
      { hint: 'Check the year and the day/month order of the dates.', count: future.length },
    );
  }
}
