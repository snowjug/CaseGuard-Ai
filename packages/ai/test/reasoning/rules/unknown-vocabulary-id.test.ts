import { describe, expect, it } from 'vitest';
import { checkUnknownVocabularyId } from '../../../src/reasoning/rules/unknown-vocabulary-id';
import { parsed, ruleContext } from '../fixtures';

const ctx = ruleContext();
const codes = (p: ReturnType<typeof parsed>) =>
  checkUnknownVocabularyId(p, ctx).map((i) => [i.code, i.path]);

describe('rule unknown_vocabulary_id', () => {
  it('lets ids from the allow-list through', () => {
    expect(codes(parsed('signal'))).toEqual([]);
    expect(codes(parsed('missing_evidence'))).toEqual([]);
    expect(codes(parsed('missed_step'))).toEqual([]);
    expect(codes(parsed('counterfactual'))).toEqual([]);
  });

  it('reports a signal that is not in the list, even a well-formed one', () => {
    expect(codes(parsed('signal', { signalId: 'sig.not-in-the-pack' }))).toEqual([
      ['unknown_vocabulary_id', 'signalId'],
    ]);
    expect(codes(parsed('signal', { signalId: 'act.dns-resolver-comparison' }))).toEqual([
      ['unknown_vocabulary_id', 'signalId'],
    ]);
  });

  it('reports a requirement or an action that is not in the list, and accepts null for both', () => {
    expect(codes(parsed('missing_evidence', { requirementId: 'req.invented' }))).toEqual([
      ['unknown_vocabulary_id', 'requirementId'],
    ]);
    expect(codes(parsed('missing_evidence', { requirementId: null }))).toEqual([]);
    expect(codes(parsed('missed_step', { actionId: 'act.invented' }))).toEqual([
      ['unknown_vocabulary_id', 'actionId'],
    ]);
    expect(codes(parsed('missed_step', { actionId: null }))).toEqual([]);
  });

  it('refuses every skill id: the reasoner is given none', () => {
    expect(codes(parsed('counterfactual', { skillId: 'skill.restart-everything' }))).toEqual([
      ['unknown_vocabulary_id', 'skillId'],
    ]);
    expect(codes(parsed('counterfactual', { skillId: null }))).toEqual([]);
  });

  it('accepts a skill id when the context names it', () => {
    const withSkill = ruleContext({
      vocabulary: { ...ctx.vocabulary, skills: new Set(['skill.dns-first']) },
    });
    expect(
      checkUnknownVocabularyId(parsed('counterfactual', { skillId: 'skill.dns-first' }), withSkill),
    ).toEqual([]);
  });

  it('has nothing to say about the other types', () => {
    for (const type of ['contradiction', 'recommendation', 'case_synthesis'] as const) {
      expect(codes(parsed(type))).toEqual([]);
    }
  });

  it('keeps to the allow-list of the context it is given', () => {
    const narrow = ruleContext({
      vocabulary: { ...ctx.vocabulary, signals: new Set(['sig.cache-clear-no-effect']) },
    });
    expect(checkUnknownVocabularyId(parsed('signal'), narrow)).toHaveLength(1);
  });
});
