import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  CoachingReportSchema,
  RESPONSIBLE_USE_NOTICE,
  type CoachingItem,
  type CoachingReport,
} from '@caseguard/schemas';
import {
  FORK_LEARNING,
  buildCoachingReport,
  computeQualityReview,
  createTemporalView,
  forkLearningItem,
  replayWarnings,
  runDeterministicAnalysis,
  type CoachingSkill,
} from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  CONFIG,
  eventBySuffix,
  loadBundle,
  prepareBundle,
  prepareCase,
  type Prepared,
} from './helpers';
import { TIMED_LINK_TYPES, linkTime, poisonAfter, poisonResolution } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);
const at = (iso: string): number => Date.parse(iso);

const SKILLS: CoachingSkill[] = [
  {
    skillId: 'skill_proxy',
    name: 'Proxy node triage',
    matchScore: 0.3,
  },
  {
    skillId: 'skill_dns',
    name: 'DNS resolver triage',
    matchScore: 0.8,
    coversActions: ['act.dns-resolver-comparison'],
  },
];

const fullReport = (
  p: Prepared,
  skills: CoachingSkill[] = SKILLS,
  synthetic = true,
): CoachingReport =>
  buildCoachingReport({
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    review: computeQualityReview({ analysis: p.analysis, pack: p.pack, ctx: p.ctx }),
    warnings: replayWarnings({
      events: p.normalized.events,
      resolution: p.normalized.resolution,
      pack: p.pack,
      ctx: p.ctx,
      analysis: p.analysis,
    }).warnings,
    skills,
    synthetic,
  });

const asOfReport = (
  p: Prepared,
  suffix: string,
  events = p.normalized.events,
  resolution = p.normalized.resolution,
) => {
  const asOf = eventBySuffix(p, suffix).timestamp;
  const analysis = runDeterministicAnalysis({
    view: createTemporalView(events, asOf, { resolution }),
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
  });
  const report = buildCoachingReport({
    analysis,
    pack: p.pack,
    ctx: p.ctx,
    review: computeQualityReview({ analysis, pack: p.pack, ctx: p.ctx, asOf }),
    warnings: replayWarnings({ events, resolution, pack: p.pack, ctx: p.ctx, asOf, analysis })
      .warnings,
    skills: SKILLS,
    synthetic: true,
  });
  return { asOf, analysis, report };
};

const forkItems = (r: CoachingReport): CoachingItem[] => [
  ...(r.missedOpportunity ? [r.missedOpportunity] : []),
  ...r.evidenceQuality,
  ...r.reasoningImprovements,
  ...r.customerEffortImprovements,
];

const allItems = (r: CoachingReport): CoachingItem[] => [
  ...r.wentWell,
  ...forkItems(r),
  ...r.communicationImprovements,
  ...(r.recommendedNextAction ? [r.recommendedNextAction] : []),
];

const textOf = (r: CoachingReport): string =>
  [
    r.summary,
    ...allItems(r).flatMap((i) => [i.title, i.detail, ...i.evidence.map((e) => e.label ?? '')]),
    r.confidence.rationale,
    ...r.limitations,
    r.notice,
  ].join('\n');

const HINDSIGHT = 'In hindsight (not known at the time, shown only to calibrate):';
const known = (item: CoachingItem): string => item.detail.split('\n\n')[0] ?? '';
const forkIdOf = (item: CoachingItem): string | undefined =>
  item.evidence.find((e) => e.type === 'fork')?.id;

const caseOne = fullReport(one);
const caseTwo = fullReport(two);

describe('coaching report on the synthetic cases (FR-CO-01)', () => {
  it('[FR-CO-01] both reports satisfy the contract and are deterministic', () => {
    for (const r of [caseOne, caseTwo]) expect(() => CoachingReportSchema.parse(r)).not.toThrow();
    expect(fullReport(one)).toEqual(caseOne);
    expect(caseOne.caseId).toBe(one.ctx.caseId);
    expect(caseOne.analysisRunId).toBe(one.ctx.runId);
    expect(caseOne.generatedAt).toBe(one.ctx.now);
  });

  it('[FR-CO-01] strengths come first: the summary leads with what went well and every case has some', () => {
    for (const r of [caseOne, caseTwo]) {
      expect(r.wentWell.length).toBeGreaterThan(0);
      expect(r.summary.indexOf('What went well')).toBeGreaterThan(-1);
      expect(r.summary).toMatch(/not a rating of a person/);
      const opportunity = r.summary.search(
        /The most useful opportunity|No decision point stood out/,
      );
      expect(r.summary.indexOf('What went well')).toBeLessThan(opportunity);
    }
    const titles = caseOne.wentWell.map((i) => i.title);
    expect(titles).toContain('A well-chosen test at the decisive moment');
    expect(caseTwo.wentWell.length).toBeGreaterThanOrEqual(3);
    const order = Object.keys(caseOne);
    expect(order.indexOf('wentWell')).toBeLessThan(order.indexOf('missedOpportunity'));
    expect(order.indexOf('wentWell')).toBeLessThan(order.indexOf('reasoningImprovements'));
  });

  it('[FR-CO-01] Case One gets one learning point per decision category, grouped by theme', () => {
    const categories = new Set(one.analysis.forks.map((f) => f.category));
    const titles = forkItems(caseOne).map((i) => i.title);
    for (const category of categories) {
      expect(titles.some((t) => t.startsWith(FORK_LEARNING[category].title))).toBe(true);
    }
    expect(forkItems(caseOne)).toHaveLength(categories.size);
    expect(caseOne.missedOpportunity?.title).toMatch(
      /^Hold disruptive changes until the cause is supported/,
    );
    expect(caseOne.evidenceQuality.length).toBeGreaterThan(0);
    expect(caseOne.reasoningImprovements.length).toBeGreaterThan(0);
    expect(caseOne.customerEffortImprovements.length).toBeGreaterThan(0);
  });

  it('[FR-CO-01] Case Two has nothing to correct: no missed opportunity and no fork-based learning points', () => {
    expect(caseTwo.missedOpportunity).toBeNull();
    expect(forkItems(caseTwo)).toEqual([]);
    expect(caseTwo.communicationImprovements).toEqual([]);
    expect(caseTwo.summary).toMatch(/No decision point stood out/);
    expect(caseTwo.recommendedNextAction?.title).toBe('Share what worked');
    expect(caseTwo.recommendedNextAction?.detail).toMatch(/reviewer approval/);
  });

  it('[FR-CO-01] communication coaching covers expectation setting and update cadence, with a lightweight next step', () => {
    const titles = caseOne.communicationImprovements.map((i) => i.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Reply sooner to messages that expect an answer',
        'Keep the customer informed without being asked',
      ]),
    );
    for (const item of caseOne.communicationImprovements) {
      expect(item.detail).toMatch(
        /Send the customer a status update with next steps and timing \(about \d+ min/,
      );
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });

  it('[FR-CO-01] a learning point reads "the record showed X at T; a lighter next step was Y because Z"', () => {
    const item = caseOne.missedOpportunity as CoachingItem;
    const paragraph = known(item);
    expect(paragraph).toMatch(/^What the record showed at 2026-03-09 12:31 UTC: /);
    expect(paragraph).toMatch(
      /The step taken was “Revoke sign-in sessions for the affected users”\./,
    );
    expect(paragraph).toMatch(
      /A lighter next step available then was “Compare name resolution across each DNS resolver” \(about 75 minutes, low customer effort, low risk; estimated\), because/,
    );
    expect(item.title).toMatch(/\(2026-03-09 12:31 UTC\)$/);
  });

  it('[FR-CO-01] every learning point links to the decision, the event and the alternative', () => {
    for (const item of forkItems(caseOne)) {
      const forkId = forkIdOf(item);
      expect(one.analysis.forks.some((f) => f.id === forkId)).toBe(true);
      expect(item.evidence.map((e) => e.type)).toEqual(expect.arrayContaining(['fork', 'event']));
      for (const link of item.evidence.filter((e) => e.type === 'event')) {
        expect(one.normalized.events.some((e) => e.id === link.id)).toBe(true);
      }
    }
  });

  it('[FR-CO-01] hindsight is separated and labelled, and never part of what was known', () => {
    const withHindsight = forkItems(caseOne).filter((i) => i.detail.includes('\n\n'));
    expect(withHindsight.length).toBeGreaterThan(0);
    for (const item of forkItems(caseOne)) {
      const [first, ...rest] = item.detail.split('\n\n');
      expect(first).not.toMatch(/hindsight/i);
      expect(rest.length).toBeLessThanOrEqual(1);
      for (const paragraph of rest) expect(paragraph.startsWith(HINDSIGHT)).toBe(true);
    }
    for (const item of [...caseOne.wentWell, ...caseOne.communicationImprovements]) {
      expect(item.detail).not.toMatch(/hindsight/i);
    }
    expect(caseOne.limitations.join(' ')).toMatch(/In hindsight/);
  });

  it('[FR-CO-01] what was known does not depend on the resolution; only the hindsight part can', () => {
    const base = loadBundle(CASE_ONE);
    const other = loadBundle(CASE_TWO).resolution;
    if (!base.resolution || !other) throw new Error('both synthetic cases have a resolution');
    const swapped = prepareBundle(
      CaseBundleSchema.parse({
        ...base,
        resolution: {
          ...base.resolution,
          rootCause: other.rootCause,
          summary: other.summary,
          rootCauseHypothesisKey: other.rootCauseHypothesisKey,
        },
      }),
    );
    const mutated = fullReport(swapped);
    const original = new Map(forkItems(caseOne).map((i) => [forkIdOf(i), i]));
    let compared = 0;
    for (const item of forkItems(mutated)) {
      const twin = original.get(forkIdOf(item));
      if (!twin) continue;
      compared += 1;
      expect(known(item)).toBe(known(twin));
    }
    expect(compared).toBeGreaterThanOrEqual(4);
  });

  it('[FR-CO-01] is constructive and never about a person: no blame, no names, no roles', () => {
    for (const r of [caseOne, caseTwo]) {
      const text = textOf(r);
      expect(text).not.toMatch(
        /\b(blame\w*|fault|mistakes?|careless\w*|negligen\w*|incompeten\w*|lazy|sloppy|failed to|should have|underperform\w*|poor performance)\b/i,
      );
      expect(text).not.toMatch(
        /Support Engineer 1|Identity Escalation Engineer|Support Manager 1|Customer IT Admin/,
      );
      expect(text).not.toMatch(/\b(the engineer|the agent|the analyst|the manager)\b/i);
    }
  });

  it('[FR-CO-01] states its limits: estimates, hindsight caveat, synthetic data, and that it is not a rating', () => {
    expect(caseOne.notice).toMatch(/not a performance rating/);
    expect(caseOne.notice).toContain(RESPONSIBLE_USE_NOTICE);
    const limits = caseOne.limitations.join(' ');
    expect(limits).toMatch(/model estimates/);
    expect(limits).toMatch(/written case record only/);
    expect(limits).toMatch(/synthetic/);
    expect(fullReport(one, SKILLS, false).limitations.join(' ')).not.toMatch(/synthetic/);
    expect(['low', 'medium']).toContain(caseOne.confidence.level);
    expect(caseOne.confidence.rationale).toMatch(/model estimates/);
    expect(caseOne.confidence.rationale).toContain(`${one.analysis.forks.length} decision points`);
  });

  it('[FR-CO-01] the closed case ends with a forward-looking tip tied to its top improvement', () => {
    const next = caseOne.recommendedNextAction as CoachingItem;
    expect(next.title).toMatch(/^For the next similar case: /);
    expect(next.evidence.length).toBeGreaterThan(0);
    expect(next.detail.length).toBeGreaterThan(30);
  });
});

describe('links to skills (FR-CO-01)', () => {
  it('[FR-CO-01] lists the best matching skills first and links an item to a skill that covers its better step', () => {
    expect(caseOne.relevantSkills.map((s) => s.skillId)).toEqual(['skill_dns', 'skill_proxy']);
    const linked = forkItems(caseOne).filter((i) => i.skillId !== null);
    expect(linked.length).toBeGreaterThan(0);
    for (const item of linked) expect(item.skillId).toBe('skill_dns');
    for (const item of forkItems(caseOne)) {
      const fork = one.analysis.forks.find((f) => f.id === forkIdOf(item));
      const better = fork?.alternatives.find((a) => a.safe)?.actionKey;
      if (item.skillId === 'skill_dns' && item !== caseOne.missedOpportunity) {
        expect(better).toBe('act.dns-resolver-comparison');
      }
    }
  });

  it('[FR-CO-01] without skills nothing is linked, and a weak match is not pushed', () => {
    const bare = fullReport(one, []);
    expect(bare.relevantSkills).toEqual([]);
    for (const item of allItems(bare)) expect(item.skillId).toBeNull();
    const weak = fullReport(one, [
      { skillId: 'skill_proxy', name: 'Proxy node triage', matchScore: 0.3 },
    ]);
    expect(weak.relevantSkills).toEqual([
      { skillId: 'skill_proxy', name: 'Proxy node triage', matchScore: 0.3 },
    ]);
    for (const item of allItems(weak)) expect(item.skillId).toBeNull();
  });

  it('[FR-CO-01] at most three skills are listed and scores are kept within 0-1', () => {
    const many: CoachingSkill[] = ['a', 'b', 'c', 'd'].map((id, i) => ({
      skillId: `skill_${id}`,
      name: `Skill ${id}`,
      matchScore: i === 0 ? 1.4 : 0.2 * (i + 1),
    }));
    const r = fullReport(one, many);
    expect(r.relevantSkills).toHaveLength(3);
    expect(r.relevantSkills.every((s) => s.matchScore >= 0 && s.matchScore <= 1)).toBe(true);
    expect(() => CoachingReportSchema.parse(r)).not.toThrow();
  });
});

describe('coaching when almost nothing is on record (FR-CO-01)', () => {
  it('[FR-CO-01] an empty view gets an honest, valid report with no invented strengths or advice', () => {
    const asOf = '2026-03-09T08:00:00Z';
    const analysis = runDeterministicAnalysis({
      view: createTemporalView(one.normalized.events, asOf),
      pack: one.pack,
      config: CONFIG,
      ctx: one.ctx,
    });
    const report = buildCoachingReport({
      analysis,
      pack: one.pack,
      ctx: one.ctx,
      review: computeQualityReview({ analysis, pack: one.pack, ctx: one.ctx, asOf }),
    });
    expect(() => CoachingReportSchema.parse(report)).not.toThrow();
    expect(report.wentWell).toEqual([]);
    expect(report.summary).toMatch(/not yet enough on record to say what went well/);
    expect(report.summary).toMatch(/No investigative step is on record yet/);
    expect(report.summary).toMatch(/cannot be estimated yet/);
    expect(report.missedOpportunity).toBeNull();
    expect(report.recommendedNextAction).toBeNull();
    expect(forkItems(report)).toEqual([]);
    expect(report.confidence.level).toBe('low');
  });
});

describe('coaching as of a moment in the case (FR-CO-01, FR-TL-06)', () => {
  const early = asOfReport(one, 'e08');

  it('[FR-CO-01] a report written mid-case says so and recommends the next step from the open prompt', () => {
    expect(() => CoachingReportSchema.parse(early.report)).not.toThrow();
    expect(early.report.summary).toMatch(/only what was on record up to 2026-03-09 12:25 UTC/);
    expect(early.report.limitations.join(' ')).toMatch(
      /Only information recorded up to 2026-03-09 12:25 UTC was used\./,
    );
    const next = early.report.recommendedNextAction as CoachingItem;
    expect(next.title).toBe('Suggested next step');
    expect(next.detail).toMatch(/Disruptive change made before the cause was established/);
    expect(next.detail).toMatch(/Compare name resolution across each DNS resolver \(about 75 min/);
  });

  it('[FR-CO-01] without warnings the next step comes from the best-ranked safe action at that moment', () => {
    const report = buildCoachingReport({
      analysis: early.analysis,
      pack: one.pack,
      ctx: one.ctx,
      review: computeQualityReview({
        analysis: early.analysis,
        pack: one.pack,
        ctx: one.ctx,
        asOf: early.asOf,
      }),
      skills: SKILLS,
    });
    const next = report.recommendedNextAction as CoachingItem;
    expect(next.title).toBe('Suggested next step');
    expect(next.detail).toMatch(
      /^Based on the evidence on record at 2026-03-09 12:25 UTC \(leading hypothesis “DNS resolution failure for sign-in endpoints”/,
    );
    expect(next.skillId).toBe('skill_dns');
  });

  it('[FR-TL-06] contains nothing that happened later: links, learning points and warnings stop at the boundary', () => {
    const { report, analysis, asOf } = early;
    for (const item of allItems(report)) {
      for (const link of item.evidence) {
        if (!TIMED_LINK_TYPES.includes(link.type)) continue;
        const time = linkTime(analysis, link);
        expect(time, `${item.title} links ${link.type}:${link.id}`).not.toBeNull();
        expect(at(time ?? '')).toBeLessThanOrEqual(at(asOf));
      }
    }
    expect(textOf(report)).not.toMatch(/Collect the minimum evidence before escalating/);
    const stamps = textOf(report).match(/20\d\d-\d\d-\d\d \d\d:\d\d UTC/g) ?? [];
    for (const stamp of stamps) {
      expect(at(`${stamp.slice(0, 10)}T${stamp.slice(11, 16)}:00Z`)).toBeLessThanOrEqual(at(asOf));
    }
  });

  it('[FR-TL-06] mutating everything after the moment (events and resolution) changes nothing', () => {
    const cut = one.normalized.events.findIndex((e) => e.id.endsWith('e08'));
    const poisoned = asOfReport(
      one,
      'e08',
      poisonAfter(one.normalized.events, cut),
      poisonResolution(one.normalized.resolution),
    );
    expect(poisoned.report).toEqual(early.report);
  });

  it('[FR-TL-06] what was known about an early decision does not change when later events are rewritten', () => {
    const cut = one.normalized.events.findIndex((e) => e.id.endsWith('e08'));
    const bundle = structuredClone(loadBundle(CASE_ONE));
    const poisonedEvents = poisonAfter(one.normalized.events, cut);
    const rewritten = prepareBundle(
      CaseBundleSchema.parse({
        ...bundle,
        events: bundle.events.map((e, i) => {
          const changed = poisonedEvents[i];
          return i > cut && changed
            ? { ...e, title: changed.title, body: changed.body, timestamp: changed.timestamp }
            : e;
        }),
      }),
    );
    const early = one.analysis.forks.filter(
      (f) => at(f.timestamp) <= at(eventBySuffix(one, 'e08').timestamp),
    );
    expect(early.length).toBeGreaterThanOrEqual(3);
    for (const fork of early) {
      const twin = rewritten.analysis.forks.find((f) => f.id === fork.id);
      if (!twin) throw new Error(`fork ${fork.id} disappeared when later events changed`);
      const extra = { skillId: null, similarCount: 0 };
      expect(known(forkLearningItem(twin, extra))).toBe(known(forkLearningItem(fork, extra)));
    }
  });
});
