import { getCompiledPack, normalizeBundle } from '@caseguard/domain';
import type { CaseBundle, CaseEvent, CaseResolution } from '@caseguard/schemas';
import type { TenantRepositories } from '../src/db';
import { SAMPLE_FILES, loadSampleBundle, toIngestInput } from './support/samples';

/** Event suffixes of Case One whose instants the temporal tests use as `asOf`. */
export const AS_OF_SUFFIXES = ['e02', 'e03', 'e07', 'e15'] as const;

/**
 * Case One cut off after its first `keep` events: an investigation still in progress, so its live
 * warnings are still open at the end of the record (a finished case has resolved them all).
 */
export async function ingestOpenCase(
  repos: TenantRepositories,
  tenantId: string,
  caseId: string,
  keep = 3,
): Promise<void> {
  const bundle: CaseBundle = structuredClone(loadSampleBundle(SAMPLE_FILES.caseOne));
  bundle.events = bundle.events.slice(0, keep);
  delete bundle.resolution;
  delete bundle.case.closedAt;
  bundle.case.status = 'open';
  bundle.case.reference = 'CG-SYN-1901';
  const payload = JSON.stringify(bundle);
  const normalized = normalizeBundle(bundle, {
    tenantId,
    caseId,
    sourceId: `src_${caseId}`,
    createdBy: 'system:test',
    now: '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: payload,
    redactionReplacements: 0,
  });
  await repos.cases.ingest(toIngestInput(normalized, payload));
}

export function eventBySuffix(events: readonly CaseEvent[], suffix: string): CaseEvent {
  const found = events.find((event) => event.id.endsWith(suffix));
  if (found === undefined) throw new Error(`No event ends with ${suffix}`);
  return found;
}

const ms = (iso: string): number => Date.parse(iso);

export const eventsAfter = (events: readonly CaseEvent[], asOf: string): CaseEvent[] =>
  events.filter((event) => ms(event.timestamp) > ms(asOf));

export const eventsUpTo = (events: readonly CaseEvent[], asOf: string): CaseEvent[] =>
  events.filter((event) => ms(event.timestamp) <= ms(asOf));

/** Identifier-like tokens: hosts, addresses, codes, versions and anything containing a digit. */
const IDENTIFIER = /[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)+|\b[A-Za-z]*\d[A-Za-z0-9]*\b/g;

/** Dates and clock times are not distinctive: legitimate stamps of earlier events look the same. */
const CALENDAR = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(?::\d{2})?)$/;

const textOf = (event: CaseEvent): string => `${event.title ?? ''}\n${event.body}`;

/**
 * Distinctive tokens that occur ONLY in what happens after `asOf` (later events and the recorded
 * resolution) and in nothing that is legitimately known by then: not in an earlier event, not in the
 * knowledge pack and not in `extraKnownText`. A response for `asOf` that contains one of them leaked.
 */
export function laterOnlyTokens(
  events: readonly CaseEvent[],
  resolution: CaseResolution | null,
  asOf: string,
  workload: string,
  extraKnownText = '',
): string[] {
  const pack = getCompiledPack(workload);
  const known = [
    ...eventsUpTo(events, asOf).map(textOf),
    pack === null ? '' : JSON.stringify(pack.pack),
    extraKnownText,
  ]
    .join('\n')
    .toLowerCase();
  const later = [
    ...eventsAfter(events, asOf).map(textOf),
    resolution === null
      ? ''
      : [resolution.summary, resolution.rootCause, resolution.workaround, resolution.permanentFix]
          .filter((text): text is string => text !== null)
          .join('\n'),
  ].join('\n');
  const tokens = new Set<string>();
  for (const token of later.match(IDENTIFIER) ?? []) {
    if (token.length >= 4 && !CALENDAR.test(token) && !known.includes(token.toLowerCase())) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** What a response for `asOf` must not contain: the ids and instants of later events, and later-only tokens. */
export interface LeakProbe {
  readonly asOf: string;
  readonly laterEventIds: string[];
  readonly laterInstants: string[];
  readonly laterTokens: string[];
}

export interface LeakProbeOptions {
  /** Text that is public by definition (case title, tags) and so never a leak. */
  readonly extraKnownText?: string;
  /** Instants of case metadata (the opening time) that a response may carry whatever `asOf` is. */
  readonly allowedInstants?: readonly string[];
}

export function leakProbe(
  events: readonly CaseEvent[],
  resolution: CaseResolution | null,
  asOf: string,
  workload: string,
  options: LeakProbeOptions = {},
): LeakProbe {
  const later = eventsAfter(events, asOf);
  const kept = new Set([
    ...eventsUpTo(events, asOf).map((event) => ms(event.timestamp)),
    ...(options.allowedInstants ?? []).map(ms),
  ]);
  return {
    asOf,
    laterEventIds: later.map((event) => event.id),
    // An instant that a kept event (or the case metadata) also has is not evidence of a leak.
    laterInstants: [
      ...new Set(later.filter((event) => !kept.has(ms(event.timestamp))).map((e) => e.timestamp)),
    ],
    laterTokens: laterOnlyTokens(events, resolution, asOf, workload, options.extraKnownText),
  };
}

/** Everything in a serialized response that betrays information from after the probe's `asOf`. */
export function findLeaks(serialized: string, probe: LeakProbe): string[] {
  const lower = serialized.toLowerCase();
  return [
    ...probe.laterEventIds
      .filter((id) => serialized.includes(`"${id}"`))
      .map((id) => `event ${id}`),
    ...probe.laterInstants
      .filter((instant) => serialized.includes(`"${instant}"`))
      .map((instant) => `instant ${instant}`),
    ...probe.laterTokens
      .filter((token) => lower.includes(token.toLowerCase()))
      .map((token) => `token ${token}`),
  ];
}
