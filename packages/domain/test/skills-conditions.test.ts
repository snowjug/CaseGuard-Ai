import { describe, expect, it } from 'vitest';
import type { SkillCondition } from '@caseguard/schemas';
import { analyzeView, createTemporalView, isSafeConditionPattern, matchSkills } from '../src';
import { buildEvidenceIndex, evaluateCondition } from '../src/skills/evidence';
import { CONFIG } from './helpers';
import { TWO, asOf, caseInfoOf, first, matchableOf, publishedAggregate } from './skills-fixtures';

const indexAt = (suffix: string) => {
  const view = createTemporalView(TWO.analysis.view.events, asOf(TWO, suffix));
  return buildEvidenceIndex(analyzeView(view, TWO.pack, TWO.ctx.caseId), caseInfoOf(TWO));
};

const condition = (over: Partial<SkillCondition>): SkillCondition => ({
  id: 'c-test',
  description: 'A test condition',
  kind: 'text',
  weight: 0.5,
  required: false,
  ...over,
});

describe('trigger condition evaluation', () => {
  const g01 = indexAt('g01');
  const skill = matchableOf(publishedAggregate());
  const trigger = (id: string): SkillCondition => {
    const found = skill.version.content.triggerConditions.find((c) => c.id === id);
    if (!found) throw new Error(`No trigger ${id}`);
    return found;
  };

  it('[FR-SK-05] a signal condition holds when the signal was observed, and cites its observations', () => {
    const met = evaluateCondition(trigger('trg-multiple-users-affected'), g01);
    expect(met.holds).toBe(true);
    expect(met.evidenceIds.length).toBeGreaterThan(0);
    expect(met.note).toBeNull();
    const unmet = evaluateCondition(trigger('trg-error-name-not-resolved'), g01);
    expect(unmet).toMatchObject({ holds: false, evidenceIds: [] });
  });

  it('[FR-SK-05] attribute conditions read the workload, observed signals and satisfied requirements', () => {
    const attr = (attribute: string) =>
      evaluateCondition(condition({ kind: 'attribute', attribute }), g01);
    expect(attr('workload=teams-authentication').holds).toBe(true);
    expect(attr('workload=exchange-mail-flow').holds).toBe(false);
    expect(attr('requirement.req.error-code').holds).toBe(true);
    expect(attr('requirement.req.sample-users').holds).toBe(false);
    const signalId = trigger('trg-multiple-users-affected').signalId;
    expect(signalId).toBeDefined();
    const bySignal = attr(`signal.${signalId ?? ''}`);
    expect(bySignal.holds).toBe(true);
    expect(bySignal.evidenceIds.length).toBeGreaterThan(0);
    expect(evaluateCondition(condition({ kind: 'attribute' }), g01)).toMatchObject({
      holds: false,
      note: 'The condition names no attribute.',
    });
    expect(evaluateCondition(condition({ kind: 'signal' }), g01)).toMatchObject({
      holds: false,
      note: 'The condition names no signal.',
    });
  });

  it('[FR-SK-05] a text condition reads only the events up to the match time', () => {
    const text = (pattern: string, index = g01) =>
      evaluateCondition(condition({ pattern }), index).holds;
    expect(text('tls inspection')).toBe(true);
    expect(text('PROXY-RTM-2')).toBe(false);
    expect(text('proxy-rtm-2', indexAt('g09'))).toBe(true);
    expect(evaluateCondition(condition({}), g01)).toMatchObject({
      holds: false,
      note: 'The condition has no pattern.',
    });
  });

  it('[NFR-SEC-05] patterns from stored skills are run only when they are safe', () => {
    for (const safe of [
      'timeout',
      '\\b(proxy|pac)\\b',
      'name (could not|not) be resolved',
      'dns[^.]{0,40}policy',
      '(\\d{4})-(\\d{2})',
    ]) {
      expect(isSafeConditionPattern(safe), safe).toBe(true);
    }
    for (const unsafe of [
      '',
      'a'.repeat(301),
      '(a+)+',
      '(a*)*b',
      '(a|aa)+',
      '(x{1,5}){1,5}',
      '(a)\\1',
      '(?<n>a)\\k<n>',
      '[unclosed',
    ]) {
      expect(isSafeConditionPattern(unsafe), unsafe).toBe(false);
    }
    expect(evaluateCondition(condition({ pattern: '(a+)+$' }), g01)).toMatchObject({
      holds: false,
      note: 'The pattern was not evaluated because it is not considered safe.',
    });
  });

  it('[NFR-SEC-05] a catastrophic pattern cannot stall matching', () => {
    const content = structuredClone(skill.version.content);
    content.triggerConditions.push(condition({ id: 'trg-redos', pattern: '(a+)+$', weight: 0.1 }));
    const hostile = { skill: skill.skill, version: { ...skill.version, content } };
    const poisoned = {
      view: createTemporalView(
        TWO.analysis.view.events.map((e) => ({ ...e, body: `${'a'.repeat(3900)}!` })),
        asOf(TWO, 'g15'),
      ),
    };
    const started = performance.now();
    const set = matchSkills({
      skills: [hostile],
      analysisAsOf: poisoned,
      asOf: asOf(TWO, 'g15'),
      pack: TWO.pack,
      config: CONFIG,
      ctx: TWO.ctx,
      caseInfo: caseInfoOf(TWO),
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(first(set.matches).unmatchedTriggers.map((u) => u.id)).toContain('trg-redos');
  });
});
