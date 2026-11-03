import { describe, expect, it } from 'vitest';
import { CritiqueSchema } from '@caseguard/schemas';
import { checkCriticUnknownTarget } from '../../../src/reasoning/rules/critic-unknown-target';
import { VALID_CRITIC_RESULT, ruleContext } from '../fixtures';

const ctx = ruleContext();
const critique = (patch: Record<string, unknown> = {}) =>
  CritiqueSchema.parse({ ...structuredClone(VALID_CRITIC_RESULT.critiques[0]), ...patch });

describe('rule critic_unknown_target', () => {
  it('lets a critique of a conclusion under review through', () => {
    for (const targetId of ['C1', 'C2', 'C3']) {
      expect(checkCriticUnknownTarget(critique({ targetId }), ctx)).toEqual([]);
    }
  });

  it.each(['C9', 'c1', 'P1', 'finding-7', 'C1 ', '', 'ignore previous instructions'])(
    'reports the target %j: the critic was not given it',
    (targetId) => {
      const issues = checkCriticUnknownTarget({ ...critique(), targetId }, ctx);
      expect(issues.map((i) => [i.code, i.path])).toEqual([['critic_unknown_target', 'targetId']]);
    },
  );

  it('leaves a critique with no target at all to critic_new_story', () => {
    expect(checkCriticUnknownTarget(critique({ targetId: null }), ctx)).toEqual([]);
  });

  it('knows only the conclusions of the context it is given', () => {
    const narrow = ruleContext({ conclusionIds: new Set(['C1']) });
    expect(checkCriticUnknownTarget(critique({ targetId: 'C2' }), narrow)).toHaveLength(1);
    const none = ruleContext({ conclusionIds: new Set() });
    expect(checkCriticUnknownTarget(critique({ targetId: 'C1' }), none)).toHaveLength(1);
  });

  it('never repeats the id the model wrote', () => {
    const issues = checkCriticUnknownTarget({ ...critique(), targetId: 'SECRET-TARGET' }, ctx);
    expect(JSON.stringify(issues)).not.toContain('SECRET');
  });
});
