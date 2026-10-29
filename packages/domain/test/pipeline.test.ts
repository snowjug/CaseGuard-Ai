import { describe, expect, it } from 'vitest';
import {
  ClaimSchema,
  DecisionForkSchema,
  DiagnosticActionSchema,
  EvidenceSchema,
  FORK_CATEGORIES,
  HypothesisEvidenceLinkSchema,
  HypothesisSchema,
  MissingEvidenceSchema,
} from '@caseguard/schemas';
import { CASE_ONE, CASE_TWO, eventBySuffix, prepareCase } from './helpers';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

describe('Case One (DNS root cause, inefficient handling)', () => {
  const a = one.analysis;
  const keyOf = (suffix: string) => eventBySuffix(one, suffix).id;
  const forkAt = (suffix: string) => a.forks.find((f) => f.eventId === keyOf(suffix));

  it('produces artefacts that satisfy the shared contract', () => {
    a.evidence.forEach((x) => expect(() => EvidenceSchema.parse(x)).not.toThrow());
    a.claims.forEach((x) => expect(() => ClaimSchema.parse(x)).not.toThrow());
    a.hypotheses.forEach((x) => expect(() => HypothesisSchema.parse(x)).not.toThrow());
    a.links.forEach((x) => expect(() => HypothesisEvidenceLinkSchema.parse(x)).not.toThrow());
    a.missing.forEach((x) => expect(() => MissingEvidenceSchema.parse(x)).not.toThrow());
    a.actions.forEach((x) => expect(() => DiagnosticActionSchema.parse(x)).not.toThrow());
    a.forks.forEach((x) => expect(() => DecisionForkSchema.parse(x)).not.toThrow());
  });

  it('FR-HY-01: the evidence converges on DNS and confidence is labelled as a model estimate', () => {
    const dns = a.hypotheses.find((h) => h.key === 'hyp.dns-resolution');
    expect(dns?.modelEstimate).toBe(true);
    expect(dns?.currentConfidence).toBeGreaterThan(0.9);
    expect(dns?.currentStatus).toBe('confirmed');
    const ranked = [...a.hypotheses].sort((x, y) => y.currentConfidence - x.currentConfidence);
    expect(ranked[0]?.key).toBe('hyp.dns-resolution');
  });

  it('FR-HY-01: each hypothesis timeline is time ordered and bounded by its confidence band', () => {
    for (const h of a.hypotheses) {
      for (let i = 1; i < h.timeline.length; i++) {
        expect((h.timeline[i]?.at ?? '') >= (h.timeline[i - 1]?.at ?? '')).toBe(true);
      }
      for (const point of h.timeline) {
        expect(point.low).toBeLessThanOrEqual(point.confidence + 1e-9);
        expect(point.high).toBeGreaterThanOrEqual(point.confidence - 1e-9);
      }
    }
  });

  it('FR-HY-02: promotion and demotion reasons are explained in plain language', () => {
    const dns = a.hypotheses.find((h) => h.key === 'hyp.dns-resolution');
    const jump = dns?.timeline.find((p) => p.delta > 0.3);
    expect(jump?.reason).toMatch(/Rose from/);
    expect(jump?.triggerEvidenceIds.length).toBeGreaterThan(0);
    expect(dns?.timeline.some((point) => point.cheapestSafeActionKey !== null)).toBe(true);
    expect(dns?.timeline.some((point) => point.missingRequirementIds.length > 0)).toBe(true);
  });

  it('FR-FK-01: flags the expected decision forks, each with one primary category', () => {
    expect(forkAt('e03')?.category).toBe('disproportionate_customer_effort');
    expect(forkAt('e07')?.category).toBe('assumption_as_fact');
    expect(forkAt('e08')?.category).toBe('premature_destructive_action');
    expect(forkAt('e09')?.category).toBe('premature_destructive_action');
    expect(forkAt('e11')?.category).toBe('low_value_action');
    expect(forkAt('e13')?.category).toBe('disproportionate_customer_effort');
    expect(forkAt('e15')?.category).toBe('contradiction_ignored');
    expect(forkAt('e16')?.category).toBe('low_value_action');
    expect(forkAt('e19')?.category).toBe('premature_escalation');
    expect(a.forks).toHaveLength(9);
  });

  it('FR-FK-03: exactly one fork is marked as the earliest meaningful and it is the first one', () => {
    const marked = a.forks.filter((f) => f.isEarliestMeaningful);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.id).toBe(a.earliestMeaningfulForkId);
    expect(marked[0]?.eventId).toBe(keyOf('e03'));
  });

  it('FR-FK-02: each fork states what was and was not known, offers safe alternatives and uses no later event', () => {
    for (const fork of a.forks) {
      const event = one.normalized.events.find((e) => e.id === fork.eventId);
      const known = new Set(fork.informationAvailable.eventIds);
      expect(known.has(fork.eventId)).toBe(false);
      for (const id of known) {
        const e = one.normalized.events.find((x) => x.id === id);
        expect(e && event && e.sequence < event.sequence).toBe(true);
      }
      expect(fork.informationUnavailable.length).toBeGreaterThan(0);
      expect(fork.alternatives.length).toBeGreaterThan(0);
      expect(fork.alternatives.every((alt) => alt.safe)).toBe(true);
      expect(fork.consequences.actual.estimated).toBe(true);
      expect(fork.eligibility.eligible).toBe(true);
      expect(fork.retrospective?.usedHindsight ?? true).toBe(true);
    }
  });

  it('FR-AV-03: remediation steps taken without a confirmed cause are never ranked as recommendations', () => {
    const decision = a.decisions.get(keyOf('e09'));
    expect(decision?.candidates.some((c) => c.actionKey === 'act.revoke-user-sessions')).toBe(
      false,
    );
    expect(decision?.blocked.some((c) => c.actionKey === 'act.revoke-user-sessions')).toBe(true);
  });

  it('FR-EV-04: detects assumption-as-fact, unsupported root cause and ignored contradictions', () => {
    const flagged = a.claims.filter((c) => c.flags.length > 0);
    const flags = new Set(flagged.flatMap((c) => c.flags));
    expect(flags.has('assumption_as_fact')).toBe(true);
    expect(flags.has('unsupported_root_cause')).toBe(true);
    expect(flags.has('ignored_contradiction')).toBe(true);
    const rootCause = a.claims.find(
      (c) => c.eventId === keyOf('e07') && c.flags.includes('unsupported_root_cause'),
    );
    expect(rootCause?.category).toBe('engineer_assumption');
    expect(rootCause?.aiCategory).toBe('engineer_assumption');
    expect(rootCause?.reviewedCategory).toBeNull();
  });

  it('FR-EV-01: the ledger uses the expected classification categories', () => {
    const categories = new Set(a.claims.map((c) => c.category));
    for (const expected of [
      'customer_reported',
      'diagnostic_evidence',
      'engineer_assumption',
      'confirmed_fact',
      'conflicting_evidence',
      'missing_evidence',
    ]) {
      expect(categories.has(expected as never), expected).toBe(true);
    }
  });

  it('FR-EV-01: a statement backed by validation is a confirmed fact; an unvalidated closure is not', () => {
    const resolution = a.claims.find(
      (c) => c.eventId === keyOf('e30') && c.category === 'confirmed_fact',
    );
    expect(resolution).toBeDefined();
    expect(a.claims.filter((c) => c.flags.includes('unvalidated_closure'))).toHaveLength(0);
  });

  it('flags repeated diagnostics and wasted customer effort on actions', () => {
    const repeat = a.actions.find((x) => x.eventId === keyOf('e11'));
    expect(repeat?.isRepeat).toBe(true);
    expect(repeat?.repeatOfActionId).toBe(a.actions.find((x) => x.eventId === keyOf('e05'))?.id);
    expect(a.actions.find((x) => x.eventId === keyOf('e13'))?.isRepeat).toBe(true);
    expect(a.actions.find((x) => x.eventId === keyOf('e23'))?.lowValue).toBe(false);
    expect(a.actions.find((x) => x.eventId === keyOf('e23'))?.relativeValueAtDecision).toBe(1);
  });

  it('every evidence link points at an existing evidence record and hypothesis', () => {
    const evidence = new Set(a.evidence.map((e) => e.id));
    const hypotheses = new Set(a.hypotheses.map((h) => h.id));
    for (const link of a.links) {
      expect(evidence.has(link.evidenceId)).toBe(true);
      expect(hypotheses.has(link.hypothesisId)).toBe(true);
      expect(['supports', 'contradicts']).toContain(link.polarity);
    }
  });

  it('missing-evidence tracking shows server-side correlation absent at escalation and satisfied afterwards', () => {
    const correlation = a.missing.find((m) => m.requirementId === 'req.server-side-correlation');
    expect(correlation?.criticality).toBe('critical');
    expect(correlation?.resolvedAt).not.toBeNull();
  });

  it('uses only fork categories defined by the contract', () => {
    for (const f of a.forks) {
      expect(FORK_CATEGORIES).toContain(f.category);
      f.additionalCategories.forEach((c) => expect(FORK_CATEGORIES).toContain(c));
    }
  });

  it('is deterministic: the same input yields identical artefacts', () => {
    const again = prepareCase(CASE_ONE);
    expect(again.analysis.forks.map((f) => [f.id, f.impactScore])).toEqual(
      a.forks.map((f) => [f.id, f.impactScore]),
    );
  });
});

describe('Case Two (proxy root cause, efficient handling)', () => {
  const a = two.analysis;

  it('identifies the proxy path without flagging sound practice', () => {
    expect(a.forks).toHaveLength(0);
    expect(a.earliestMeaningfulForkId).toBeNull();
    const ranked = [...a.hypotheses].sort((x, y) => y.currentConfidence - x.currentConfidence);
    expect(ranked[0]?.key).toBe('hyp.proxy-egress');
    expect(ranked[0]?.currentConfidence).toBeGreaterThan(0.85);
  });

  it('raises no assumption-as-fact, unsupported or contradiction flags', () => {
    expect(a.claims.filter((c) => c.flags.length > 0)).toHaveLength(0);
    expect(a.actions.filter((x) => x.lowValue || x.isRepeat)).toHaveLength(0);
  });
});
