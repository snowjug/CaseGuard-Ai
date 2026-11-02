import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY_CONFIG, type CoachingItem, type EvidenceLink } from '@caseguard/schemas';
import {
  buildCoachingReport,
  computeQualityReview,
  createTemporalView,
  replayWarnings,
  runDeterministicAnalysis,
  verifyExcerpt,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, prepareCase, type Prepared } from './helpers';
import { computeCase, type CaseComputation } from './engine-golden';

interface Cited {
  /** Where the link was found, for a failure message. */
  where: string;
  link: EvidenceLink;
}

/** Every link on every recommendation, finding and metric of a case. */
function citedBy(c: CaseComputation): Cited[] {
  const out: Cited[] = [];
  const add = (where: string, links: readonly EvidenceLink[]): void => {
    for (const link of links) out.push({ where, link });
  };
  for (const d of c.review.dimensions)
    for (const s of d.subChecks) add(`sub-check ${d.key}/${s.id}`, s.evidence);
  for (const p of c.review.penalties) add(`penalty ${p.key}`, p.evidence);
  for (const i of c.review.improvements) add(`improvement ${i.title}`, i.evidence);
  for (const w of c.warnings) add(`warning ${w.ruleId}`, w.evidence);
  const coaching: [string, CoachingItem | null][] = [
    ...c.coaching.wentWell.map((i) => ['wentWell', i] as [string, CoachingItem]),
    ['missedOpportunity', c.coaching.missedOpportunity],
    ...c.coaching.evidenceQuality.map((i) => ['evidenceQuality', i] as [string, CoachingItem]),
    ...c.coaching.reasoningImprovements.map((i) => ['reasoning', i] as [string, CoachingItem]),
    ...c.coaching.communicationImprovements.map(
      (i) => ['communication', i] as [string, CoachingItem],
    ),
    ...c.coaching.customerEffortImprovements.map(
      (i) => ['customerEffort', i] as [string, CoachingItem],
    ),
    ['recommendedNextAction', c.coaching.recommendedNextAction],
  ];
  for (const [section, item] of coaching) if (item) add(`coaching ${section}`, item.evidence);
  for (const m of c.metrics) {
    for (const contributor of m.contributors) add(`metric ${m.key}`, contributor.evidence);
    for (const component of m.ase?.components ?? [])
      add(`ase ${component.key}`, component.evidence);
  }
  return out;
}

/** What the API resolves a link against: the analysis of the window and, for a simulated path, the stored scenarios. */
function resolverFor(prepared: Prepared, c: CaseComputation) {
  const { analysis } = c;
  const eventById = new Map(analysis.view.events.map((e) => [e.id, e]));
  return (link: EvidenceLink): string | null => {
    switch (link.type) {
      case 'event':
        return eventById.has(link.id) ? 'event' : null;
      case 'evidence':
      case 'claim': {
        const record =
          link.type === 'evidence'
            ? analysis.evidence.find((e) => e.id === link.id)
            : analysis.claims.find((x) => x.id === link.id);
        if (!record) return null;
        const event = record.eventId === null ? undefined : eventById.get(record.eventId);
        // A record that quotes the text is verified against it; one with no location claims nothing.
        const check = verifyExcerpt(
          event ?? { id: '', title: null, body: '' },
          record.sourceRef ?? undefined,
        );
        if (check.verification === 'mismatch') return `mismatch (${check.reason})`;
        return check.verification;
      }
      case 'fork':
        return analysis.forks.some((x) => x.id === link.id) ? 'fork' : null;
      case 'action':
        return analysis.actions.some((x) => x.id === link.id) ? 'action' : null;
      case 'hypothesis':
        return analysis.hypotheses.some((x) => x.id === link.id || x.key === link.id)
          ? 'hypothesis'
          : null;
      case 'requirement':
        // The case's own record of it, or else what the knowledge pack defines (the case may not have reached it).
        return analysis.missing.some((x) => x.requirementId === link.id || x.id === link.id) ||
          prepared.pack.requirements.has(link.id)
          ? 'requirement'
          : null;
      case 'scenario':
        return c.scenarios.some((x) => x.id === link.id) ? 'scenario' : null;
    }
  };
}

/** The same pipeline the API runs for a window of the case. */
function computeAt(prepared: Prepared, asOf: string): CaseComputation {
  const { normalized, pack, ctx } = prepared;
  const { events, resolution } = normalized;
  const view = createTemporalView(events, asOf, { resolution });
  const analysis = runDeterministicAnalysis({ view, pack, config: CONFIG, ctx });
  const review = computeQualityReview({
    analysis,
    pack,
    ctx,
    config: DEFAULT_QUALITY_CONFIG,
    actionConfig: CONFIG,
    asOf,
  });
  const replay = replayWarnings({ events, resolution, pack, ctx, config: CONFIG, asOf, analysis });
  const coaching = buildCoachingReport({
    analysis,
    pack,
    ctx,
    review,
    warnings: replay.warnings,
    skills: [],
    config: CONFIG,
  });
  // A window has no simulated path and no digital twin of its own here: nothing links to them.
  return {
    analysis,
    review,
    warnings: replay.warnings,
    coaching,
    scenarios: [],
    metrics: [],
    twin: undefined as never,
  };
}

const SAMPLES = [
  ['Case One', CASE_ONE],
  ['Case Two', CASE_TWO],
] as const;

describe('every link on a recommendation leads to something in the record', () => {
  for (const [name, file] of SAMPLES) {
    const prepared = prepareCase(file);

    it(`${name}: in the whole record, every link resolves and every cited text is verified`, () => {
      const c = computeCase(prepared);
      const resolve = resolverFor(prepared, c);
      const cited = citedBy(c);
      expect(cited.length).toBeGreaterThan(20);
      const kinds = new Set<string>();
      for (const { where, link } of cited) {
        const found = resolve(link);
        expect(found, `${where}: ${link.type}:${link.id}`).not.toBeNull();
        expect(found, `${where}: ${link.type}:${link.id}`).not.toMatch(/^mismatch/);
        kinds.add(link.type);
      }
      // Both text and derived citations are exercised.
      expect(kinds.has('event')).toBe(true);
    });

    it(`${name}: as of every message, a link only leads to what was known by then`, () => {
      for (const event of prepared.normalized.events) {
        const c = computeAt(prepared, event.timestamp);
        const resolve = resolverFor(prepared, c);
        for (const { where, link } of citedBy(c)) {
          const found = resolve(link);
          expect(
            found,
            `as of ${event.timestamp}, ${where}: ${link.type}:${link.id}`,
          ).not.toBeNull();
          expect(found, `as of ${event.timestamp}, ${where}`).not.toMatch(/^mismatch/);
        }
      }
    }, 120_000);
  }
});
