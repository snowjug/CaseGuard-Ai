import { describe, expect, it } from 'vitest';
import {
  CaseWarningSchema,
  WARNING_CATEGORIES,
  type CaseWarning,
  type Priority,
} from '@caseguard/schemas';
import {
  LIVE_WARNING_RULES,
  WARNING_NOTICE,
  evaluateLiveWarnings,
  replayWarnings,
  viewWarningsAsOf,
  type WarningReplay,
} from '../src';
import { CASE_ONE, CASE_TWO, eventBySuffix, prepareCase, type Prepared } from './helpers';
import { TIMED_LINK_TYPES, linkTime } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

const replay = (p: Prepared): WarningReplay =>
  replayWarnings({
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    ctx: p.ctx,
    analysis: p.analysis,
  });

const caseOne = replay(one);
const caseTwo = replay(two);
const at = (iso: string): number => Date.parse(iso);
const byKey = (r: WarningReplay, fingerprint: string): CaseWarning => {
  const found = r.warnings.find((w) => w.fingerprint === fingerprint);
  if (!found) throw new Error(`no warning ${fingerprint}`);
  return found;
};

const PRIORITY: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATE = { open: 0, dismissed: 1, resolved: 2 } as const;

describe('replaying Case One (FR-LQ-01, FR-LQ-02)', () => {
  it('[FR-LQ-01] raises the unsupported-root-cause warning at the moment of e07', () => {
    const w = byKey(caseOne, 'LQ-EVD-02|hyp.conditional-access');
    expect(at(w.raisedAt)).toBe(at(eventBySuffix(one, 'e07').timestamp));
    expect(w.category).toBe('evidence');
    expect(w.priority).toBe('high');
    expect(w.ruleId).toBe('LQ-EVD-02');
    expect(w.message).toMatch(/states .* as established/);
    expect(w.message).toMatch(/no supporting diagnostic evidence is cited/);
  });

  it('[FR-LQ-01] raises the destructive-action warning at the moment of e08 (and again for e09)', () => {
    const w = byKey(caseOne, 'LQ-TRB-03|e08');
    expect(at(w.raisedAt)).toBe(at(eventBySuffix(one, 'e08').timestamp));
    expect(w.category).toBe('troubleshooting');
    expect(w.priority).toBe('critical');
    expect(w.message).toMatch(/went ahead while the hypothesis it targets stood at 1%/);
    expect(w.suggestedAction).toMatch(/safer, higher-value step/);
    const next = byKey(caseOne, 'LQ-TRB-03|e09');
    expect(at(next.raisedAt)).toBe(at(eventBySuffix(one, 'e09').timestamp));
  });

  it('[FR-LQ-01] warns about missing minimum evidence before the e19 escalation, then again when it happens', () => {
    const planned = byKey(caseOne, 'LQ-EVD-01|planned');
    const recorded = byKey(caseOne, 'LQ-EVD-01|recorded');
    expect(at(planned.raisedAt)).toBeLessThan(at(eventBySuffix(one, 'e19').timestamp));
    expect(planned.message).toMatch(/Server-side sign-in log correlation/);
    expect(planned.priority).toBe('medium');
    expect(at(recorded.raisedAt)).toBe(at(eventBySuffix(one, 'e19').timestamp));
    expect(recorded.priority).toBe('high');
    expect(planned.resolvedReason).toMatch(/Superseded by a more severe warning/);
  });

  it('[FR-LQ-01] flags the customer waiting for a reply, first after 4 hours and then after a day', () => {
    const e14 = eventBySuffix(one, 'e14');
    const four = byKey(caseOne, 'LQ-COM-01|e14:4h');
    const day = byKey(caseOne, 'LQ-COM-01|e14:24h');
    expect(at(four.raisedAt) - at(e14.timestamp)).toBe(4 * 3_600_000);
    expect(at(day.raisedAt) - at(e14.timestamp)).toBe(24 * 3_600_000);
    expect(four.priority).toBe('medium');
    expect(day.priority).toBe('high');
    expect(four.resolvedReason).toMatch(/Superseded/);
    expect(day.resolvedReason).toMatch(/customer was answered/);
  });

  it('[FR-LQ-01] covers repeated diagnostics, known outcomes, heavy asks and contradicted hypotheses', () => {
    const keys = caseOne.warnings.map((w) => w.fingerprint);
    expect(keys).toEqual(
      expect.arrayContaining([
        'LQ-TRB-01|e11',
        'LQ-TRB-01|e13',
        'LQ-TRB-02|e16',
        'LQ-TRB-04|e03',
        'LQ-COM-02|e03',
        'LQ-EVD-03|hyp.conditional-access',
      ]),
    );
    expect(new Set(caseOne.warnings.map((w) => w.category))).toEqual(
      new Set(['evidence', 'troubleshooting', 'communication']),
    );
  });

  it('[FR-LQ-01] every warning satisfies the contract and is plain language', () => {
    for (const w of caseOne.warnings) {
      expect(() => CaseWarningSchema.parse(w)).not.toThrow();
      expect(WARNING_CATEGORIES).toContain(w.category);
      expect(w.message.length).toBeGreaterThan(40);
      expect(w.title.length).toBeGreaterThan(10);
      expect(`${w.title} ${w.message} ${w.suggestedAction}`).not.toMatch(
        /\b(hyp|req|act|sig)\.[a-z]/,
      );
      expect(w.analysisRunId).toBe(one.ctx.runId);
      expect(w.caseId).toBe(one.ctx.caseId);
    }
  });

  it('[FR-LQ-01] every warning suggests a safer next step from the pack with its cost, effort and risk', () => {
    const labels = [...one.pack.actions.values()].map((a) => a.label);
    for (const w of caseOne.warnings) {
      expect(labels.some((label) => w.suggestedAction.includes(label))).toBe(true);
      expect(w.suggestedAction).toMatch(
        /\(about \d+ min, [a-z ]+ customer effort, [a-z]+ risk, ~\d+ tokens; estimates from the knowledge pack\)/,
      );
    }
  });

  it('[FR-LQ-01] every warning is evidence-linked and links only to things that existed when it was raised', () => {
    for (const w of caseOne.warnings) {
      expect(w.evidence.length).toBeGreaterThan(0);
      for (const link of w.evidence) {
        if (!TIMED_LINK_TYPES.includes(link.type)) continue;
        const time = linkTime(one.analysis, link);
        expect(time, `${w.fingerprint} links ${link.type}:${link.id}`).not.toBeNull();
        expect(at(time ?? '')).toBeLessThanOrEqual(at(w.raisedAt));
      }
    }
  });

  it('[FR-LQ-02] no warning mentions the title of an event that came later', () => {
    const titleCount = new Map<string, number>();
    for (const e of one.normalized.events) {
      if (e.title) titleCount.set(e.title, (titleCount.get(e.title) ?? 0) + 1);
    }
    for (const w of caseOne.warnings) {
      const text = `${w.title} ${w.message} ${w.suggestedAction}`;
      for (const e of one.normalized.events) {
        if (!e.title || e.title.length < 12 || titleCount.get(e.title) !== 1) continue;
        if (at(e.timestamp) > at(w.raisedAt)) expect(text).not.toContain(e.title);
      }
    }
  });

  it('[FR-LQ-01] warnings are deduplicated: one per rule and subject, however often the condition re-fires', () => {
    const fingerprints = caseOne.warnings.map((w) => w.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(new Set(caseOne.warnings.map((w) => w.id)).size).toBe(caseOne.warnings.length);
    expect(fingerprints.every((f) => !f.includes('#'))).toBe(true);
    const raised = caseOne.transitions.filter((t) => t.kind === 'raised');
    expect(raised).toHaveLength(caseOne.warnings.length);
    expect(caseOne.checkpoints).toBeGreaterThan(one.normalized.events.length);
  });

  it('[FR-LQ-01] warnings resolve automatically when the condition no longer holds', () => {
    expect(caseOne.counts.open).toBe(0);
    expect(caseOne.counts.dismissed).toBe(0);
    expect(caseOne.counts.resolved).toBe(caseOne.warnings.length);
    for (const w of caseOne.warnings) {
      expect(w.state).toBe('resolved');
      expect(w.resolvedAt).not.toBeNull();
      expect(at(w.resolvedAt ?? '')).toBeGreaterThanOrEqual(at(w.raisedAt));
      expect(w.resolvedReason?.length ?? 0).toBeGreaterThan(20);
      expect(w.dismissal).toBeNull();
    }
    const unsupported = byKey(caseOne, 'LQ-EVD-02|hyp.conditional-access');
    expect(unsupported.resolvedReason).toMatch(/no longer presents the cause as established fact/);
    expect(at(unsupported.resolvedAt ?? '')).toBeLessThan(at(eventBySuffix(one, 'e19').timestamp));
    const destructive = byKey(caseOne, 'LQ-TRB-03|e08');
    expect(at(destructive.resolvedAt ?? '')).toBe(at(eventBySuffix(one, 'e09').timestamp));
    const recorded = byKey(caseOne, 'LQ-EVD-01|recorded');
    expect(recorded.resolvedReason).toMatch(/minimum evidence for escalation is now on record/);
    const answered = byKey(caseOne, 'LQ-COM-01|e14:24h');
    const reply = one.normalized.events.find(
      (e) => at(e.timestamp) === at(answered.resolvedAt ?? ''),
    );
    expect(reply?.type).toBe('engineer_email');
  });

  it('[FR-LQ-01] the audit trail records every raise, resolution and supersession', () => {
    const kinds = caseOne.transitions.map((t) => t.kind);
    expect(kinds.filter((k) => k === 'raised')).toHaveLength(caseOne.warnings.length);
    expect(kinds.filter((k) => k === 'superseded')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'resolved' || k === 'superseded')).toHaveLength(
      caseOne.counts.resolved,
    );
    expect(kinds).not.toContain('dismissed');
    for (const w of caseOne.warnings) {
      const own = caseOne.transitions.filter((t) => t.warningId === w.id);
      expect(own.map((t) => t.kind)[0]).toBe('raised');
      expect(own).toHaveLength(2);
    }
  });

  it('[FR-LQ-01] ranks warnings: open first, then priority, with unique ranks starting at 1', () => {
    const ranks = caseOne.warnings.map((w) => w.rank);
    expect(ranks).toEqual(caseOne.warnings.map((_, i) => i + 1));
    for (let i = 1; i < caseOne.warnings.length; i += 1) {
      const a = caseOne.warnings[i - 1] as CaseWarning;
      const b = caseOne.warnings[i] as CaseWarning;
      expect(STATE[a.state] * 10 + PRIORITY[a.priority]).toBeLessThanOrEqual(
        STATE[b.state] * 10 + PRIORITY[b.priority],
      );
    }
    expect(caseOne.warnings[0]?.priority).toBe('critical');
  });

  it('[FR-LQ-01] replaying is deterministic', () => {
    expect(replay(one)).toEqual(caseOne);
  });
});

describe('what is open at a given moment (FR-LQ-02)', () => {
  it('[FR-LQ-02] at e08 the open warnings are the unsupported cause, the contradiction and the disruptive step', () => {
    const open = viewWarningsAsOf(caseOne.warnings, eventBySuffix(one, 'e08').timestamp).filter(
      (w) => w.state === 'open',
    );
    expect(open.map((w) => w.fingerprint).sort()).toEqual([
      'LQ-EVD-02|hyp.conditional-access',
      'LQ-EVD-03|hyp.conditional-access',
      'LQ-TRB-03|e08',
    ]);
    expect(open[0]?.fingerprint).toBe('LQ-TRB-03|e08');
    expect(open.every((w) => w.resolvedAt === null && w.resolvedReason === null)).toBe(true);
  });

  it('[FR-LQ-02] nothing is open before the first questionable step', () => {
    const before = viewWarningsAsOf(caseOne.warnings, eventBySuffix(one, 'e02').timestamp);
    expect(before).toEqual([]);
  });

  it('[FR-LQ-02] a single evaluation on the full view reports only what still holds at the end', () => {
    const evaluation = evaluateLiveWarnings({
      analysis: one.analysis,
      pack: one.pack,
      ctx: one.ctx,
    });
    expect(evaluation.open).toEqual([]);
    expect(evaluation.evaluatedAt).toBe(one.analysis.view.events.at(-1)?.timestamp);
  });
});

describe('Case Two raises nothing material (FR-LQ-01)', () => {
  it('[FR-LQ-01] the efficient case produces no warnings at any checkpoint', () => {
    expect(caseTwo.warnings).toEqual([]);
    expect(caseTwo.counts).toEqual({
      total: 0,
      open: 0,
      resolved: 0,
      dismissed: 0,
      openByCategory: { scoping: 0, evidence: 0, troubleshooting: 0, communication: 0, closure: 0 },
    });
    expect(caseTwo.checkpoints).toBeGreaterThanOrEqual(two.normalized.events.length);
    expect(caseTwo.transitions).toEqual([]);
    expect(
      evaluateLiveWarnings({ analysis: two.analysis, pack: two.pack, ctx: two.ctx }).warnings,
    ).toEqual([]);
  });
});

describe('rule catalogue and framing (FR-LQ-01)', () => {
  it('[FR-LQ-01] covers the five categories and every rule the replays raised', () => {
    expect(new Set(LIVE_WARNING_RULES.map((r) => r.category))).toEqual(new Set(WARNING_CATEGORIES));
    const ids = LIVE_WARNING_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of LIVE_WARNING_RULES) {
      expect(rule.title.length).toBeGreaterThan(10);
      expect(rule.description.length).toBeGreaterThan(30);
    }
    for (const w of caseOne.warnings) expect(ids).toContain(w.ruleId);
  });

  it('[FR-LQ-01] implements each of the required rules', () => {
    const required: Record<string, string> = {
      'LQ-EVD-01': 'minimum evidence missing before or at escalation',
      'LQ-TRB-01': 'repeated diagnostic',
      'LQ-TRB-02': 'outcome already known',
      'LQ-EVD-02': 'unsupported root cause stated as fact',
      'LQ-EVD-03': 'working hypothesis contradicted by evidence',
      'LQ-TRB-03': 'destructive or risky step without justification',
      'LQ-TRB-04': 'heavy customer ask when a lighter one exists',
      'LQ-COM-01': 'no customer update for N hours',
      'LQ-CLS-01': 'closure without validation or customer confirmation',
      'LQ-CLS-02': 'workaround and permanent fix conflated',
    };
    const ids = new Set(LIVE_WARNING_RULES.map((r) => r.id));
    for (const id of Object.keys(required)) expect(ids.has(id), required[id]).toBe(true);
  });

  it('[FR-LQ-01] warnings are framed as supportive prompts, never judgements of a person', () => {
    expect(caseOne.notice).toBe(WARNING_NOTICE);
    expect(WARNING_NOTICE).toMatch(/supportive prompts/);
    expect(WARNING_NOTICE).toMatch(/not judgements/);
    const text = JSON.stringify(caseOne.warnings);
    expect(text).not.toMatch(/Support Engineer 1|Identity Escalation Engineer|Support Manager 1/);
    expect(text).not.toMatch(
      /\b(careless|negligen\w*|incompeten\w*|lazy|sloppy|blame\w*|fault)\b/i,
    );
  });
});
