import { describe, expect, it } from 'vitest';
import { validateKnowledgePackReferences } from '@caseguard/schemas';
import { TEAMS_AUTH_PACK, compileKnowledgePack, getCompiledPack, listKnowledgePacks } from '../src';

describe('teams authentication knowledge pack', () => {
  const compiled = compileKnowledgePack(TEAMS_AUTH_PACK);
  const pack = compiled.pack;

  it('FR-HY-01: priors form a probability distribution and include a catch-all', () => {
    const total = pack.hypotheses.reduce((s, h) => s + h.prior, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(pack.hypotheses.some((h) => h.id === 'hyp.other')).toBe(true);
  });

  it('is internally consistent (every reference resolves)', () => {
    expect(validateKnowledgePackReferences(pack)).toEqual([]);
  });

  it('every signal lists a likelihood for every hypothesis within the clamp range', () => {
    for (const signal of pack.signals) {
      for (const h of pack.hypotheses) {
        const value = signal.likelihoods[h.id] ?? signal.neutral;
        expect(value, `${signal.id} / ${h.id}`).toBeGreaterThanOrEqual(0.01);
        expect(value, `${signal.id} / ${h.id}`).toBeLessThanOrEqual(0.99);
      }
    }
  });

  it('every signal has at least one detector and a human explanation', () => {
    for (const signal of pack.signals) {
      expect(signal.detectors.length, signal.id).toBeGreaterThan(0);
      expect(signal.explanation.length, signal.id).toBeGreaterThan(20);
    }
  });

  it('FR-AV-01: each diagnostic action defines a "no finding" or complete outcome set', () => {
    for (const action of pack.actions) {
      if (action.valueClass !== 'diagnostic' && action.valueClass !== 'enabling') continue;
      if (action.outcomes.length === 0) continue; // e.g. escalation: gated, never simulated for information
      const hasNoSignalOutcome = action.outcomes.some((o) => o.emitsSignals.length === 0);
      // Either an explicit "nothing found" outcome, or two or more mutually exclusive signal outcomes.
      expect(hasNoSignalOutcome || action.outcomes.length >= 2, action.id).toBe(true);
    }
  });

  it('FR-CF-04: destructive or high-risk actions are classed as remediation and need approval or a high threshold', () => {
    for (const action of pack.actions) {
      if (action.destructive) expect(action.valueClass, action.id).toBe('remediation');
      if (action.operationalRisk >= 0.5) expect(action.valueClass, action.id).toBe('remediation');
    }
  });

  it('actions only require and produce known requirements', () => {
    const ids = new Set(pack.requirements.map((r) => r.id));
    for (const action of pack.actions) {
      for (const r of [...action.requires, ...action.produces])
        expect(ids.has(r), `${action.id} -> ${r}`).toBe(true);
    }
  });

  it('compiles every detector regular expression and every lexicon phrase', () => {
    expect(compiled.signalDetectors.size).toBe(pack.signals.length);
    expect(compiled.lexicon.hedges.length).toBeGreaterThan(5);
    expect(compiled.claimPatterns.length).toBeGreaterThan(0);
  });

  it('is discoverable by workload', () => {
    expect(listKnowledgePacks().length).toBeGreaterThan(0);
    expect(getCompiledPack('teams-authentication')?.pack.id).toBe('kp.teams-authentication');
    expect(getCompiledPack('unknown-workload')).toBeNull();
  });

  it('carries an honesty disclaimer', () => {
    expect(pack.disclaimer).toMatch(/illustrative|estimate/i);
  });
});
