import {
  CaseBundleSchema,
  type CaseBundle,
  type CaseEvent,
  type CaseResolution,
  type CounterfactualScenario,
  type CounterfactualStrategy,
  type EvidenceLink,
} from '@caseguard/schemas';
import { generateCounterfactuals, type DeterministicAnalysis } from '../src';
import { CASE_ONE, CONFIG, loadBundle, type Prepared } from './helpers';

export type BundleEvent = CaseBundle['events'][number];

export const STRATEGIES: CounterfactualStrategy[] = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
];

/** Links that point at something with a point in time; requirements and hypotheses have none. */
export const TIMED_LINK_TYPES: readonly EvidenceLink['type'][] = [
  'event',
  'action',
  'fork',
  'claim',
  'evidence',
];

/** The instant an evidence link refers to (null when the link has no time or does not resolve). */
export function linkTime(analysis: DeterministicAnalysis, link: EvidenceLink): string | null {
  switch (link.type) {
    case 'event':
      return analysis.view.events.find((e) => e.id === link.id)?.timestamp ?? null;
    case 'action':
      return analysis.actions.find((a) => a.id === link.id)?.startedAt ?? null;
    case 'fork':
      return analysis.forks.find((f) => f.id === link.id)?.timestamp ?? null;
    case 'claim':
      return analysis.claims.find((c) => c.id === link.id)?.timestamp ?? null;
    case 'evidence':
      return analysis.evidence.find((e) => e.id === link.id)?.observedAt ?? null;
    default:
      return null;
  }
}

const scenarioCache = new Map<string, CounterfactualScenario[]>();

/** Simulated alternatives for every decision fork of a prepared case (computed once per case). */
export function scenariosFor(p: Prepared, rolloutCount = 60): CounterfactualScenario[] {
  const key = `${p.bundle.case.reference}:${rolloutCount}`;
  const hit = scenarioCache.get(key);
  if (hit) return hit;
  const scenarios = p.analysis.forks.flatMap(
    (fork) =>
      generateCounterfactuals({
        analysis: p.analysis,
        fork,
        strategies: STRATEGIES,
        events: p.normalized.events,
        resolution: p.normalized.resolution,
        pack: p.pack,
        config: CONFIG,
        ctx: p.ctx,
        rolloutCount,
      }).scenarios,
  );
  scenarioCache.set(key, scenarios);
  return scenarios;
}

export const POISON =
  'ROOT CAUSE IS A QUANTUM FLUX CAPACITOR AT 192.0.2.77 (host qfc-77.poison.example.net)';

const shift = (timestamp: string, ms: number): string =>
  new Date(Date.parse(timestamp) + ms).toISOString();

/** Rewrites the content of every event after `index` and moves it later; order and the prefix are untouched. */
export function poisonAfter(events: readonly CaseEvent[], index: number): CaseEvent[] {
  return events.map((e, i) =>
    i > index
      ? { ...e, title: POISON, body: `${POISON} (${i})`, timestamp: shift(e.timestamp, 3_600_000) }
      : e,
  );
}

export function poisonResolution(resolution: CaseResolution | null): CaseResolution | null {
  return resolution
    ? {
        ...resolution,
        summary: POISON,
        rootCause: POISON,
        workaround: POISON,
        permanentFix: null,
        resolvedAt: shift(resolution.resolvedAt, 3_600_000),
      }
    : null;
}

/** A copy of Case One cut after `keep` events, with `extra` events appended and a replacement resolution. */
export function variantOfCaseOne(
  keep: number,
  extra: readonly BundleEvent[] = [],
  resolution?: CaseBundle['resolution'],
): CaseBundle {
  const copy = structuredClone(loadBundle(CASE_ONE));
  return CaseBundleSchema.parse({
    ...copy,
    events: [...copy.events.slice(0, keep), ...extra],
    resolution,
  });
}

export const engineerEvent = (init: {
  id: string;
  timestamp: string;
  body: string;
  title?: string;
  type?: BundleEvent['type'];
  participantId?: string;
  action?: BundleEvent['action'];
  structured?: BundleEvent['structured'];
}): BundleEvent => ({
  id: init.id,
  timestamp: init.timestamp,
  participantId: init.participantId ?? 'p-eng',
  type: init.type ?? 'case_note',
  channel: init.type === 'engineer_email' ? 'email' : 'internal',
  title: init.title ?? 'Update',
  body: init.body,
  correlationIds: [],
  ...(init.action ? { action: init.action } : {}),
  ...(init.structured ? { structured: init.structured } : {}),
});

export const customerEvent = (init: {
  id: string;
  timestamp: string;
  body: string;
  title?: string;
  structured?: BundleEvent['structured'];
}): BundleEvent => ({
  id: init.id,
  timestamp: init.timestamp,
  participantId: 'p-cust-admin',
  type: 'customer_email',
  channel: 'email',
  title: init.title ?? 'Re: update',
  body: init.body,
  correlationIds: [],
  ...(init.structured ? { structured: init.structured } : {}),
});
