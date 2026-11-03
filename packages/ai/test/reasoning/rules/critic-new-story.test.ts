import { describe, expect, it } from 'vitest';
import { CritiqueSchema } from '@caseguard/schemas';
import { checkCriticNewStory } from '../../../src/reasoning/rules/critic-new-story';
import { VALID_CRITIC_RESULT, ruleContext } from '../fixtures';

const ctx = ruleContext();
const first = VALID_CRITIC_RESULT.critiques[0];
const second = VALID_CRITIC_RESULT.critiques[1];
const critique = (base: object, patch: Record<string, unknown> = {}) =>
  CritiqueSchema.parse({ ...structuredClone(base), ...patch });
const found = (c: ReturnType<typeof critique>) =>
  checkCriticNewStory(c, ctx).map((i) => [i.code, i.path]);

describe('rule critic_new_story', () => {
  it('lets a critique with a target and a citation through', () => {
    expect(found(critique(first))).toEqual([]);
  });

  it('refuses a critique that is about nothing in particular', () => {
    expect(found(critique(first, { targetId: null }))).toEqual([['critic_new_story', 'targetId']]);
  });

  it('refuses a critique that cites no event', () => {
    expect(found(critique(first, { evidence: [] }))).toEqual([['critic_new_story', 'evidence']]);
  });

  it('reports both at once', () => {
    expect(found(critique(first, { targetId: null, evidence: [] })).map((i) => i[1])).toEqual([
      'targetId',
      'evidence',
    ]);
  });

  it('lets an alternative explanation name a hypothesis of the pack', () => {
    expect(found(critique(second))).toEqual([]);
    expect(found(critique(second, { alternativeHypothesisId: 'hyp.conditional-access' }))).toEqual(
      [],
    );
  });

  it.each([
    null,
    'hyp.invented-cause',
    'the proxy was misconfigured',
    'act.dns-resolver-comparison',
    'sig.mfa-ca-events-in-logs',
  ])(
    'refuses an alternative explanation that names %j: it is a new story, not a hypothesis of the pack',
    (alternativeHypothesisId) => {
      expect(found(critique(second, { alternativeHypothesisId }))).toEqual([
        ['critic_new_story', 'alternativeHypothesisId'],
      ]);
    },
  );

  it('does not read the hypothesis field of another kind of critique', () => {
    expect(found(critique(first, { alternativeHypothesisId: 'hyp.invented-cause' }))).toEqual([]);
  });

  it('checks the hypothesis against the pack of the context it is given', () => {
    const narrow = ruleContext({
      vocabulary: { ...ctx.vocabulary, hypotheses: new Set(['hyp.conditional-access']) },
    });
    expect(checkCriticNewStory(critique(second), narrow)).toHaveLength(1);
  });
});
