import { describe, expect, it } from 'vitest';
import { checkModelBasisOverclaim } from '../../../src/reasoning/rules/model-basis-overclaim';
import { proposal } from '../fixtures';

describe('rule model_basis_overclaim', () => {
  it.each(['model_estimate', 'illustrative'])(
    'does not report the basis %s: it is not one only the engine may claim',
    (basis) => {
      expect(checkModelBasisOverclaim(proposal('counterfactual', { basis }))).toEqual([]);
    },
  );

  it.each(['measured', 'deterministic_estimate'])(
    'refuses the basis %s: only the engine may claim it',
    (basis) => {
      const issues = checkModelBasisOverclaim(proposal('counterfactual', { basis }));
      expect(issues.map((i) => [i.code, i.path])).toEqual([['model_basis_overclaim', 'basis']]);
    },
  );

  it('leaves a basis that is simply not one of the four to the schema', () => {
    expect(checkModelBasisOverclaim(proposal('counterfactual', { basis: 'a_guess' }))).toEqual([]);
    expect(checkModelBasisOverclaim(proposal('counterfactual', { basis: 7 }))).toEqual([]);
    expect(checkModelBasisOverclaim(proposal('counterfactual', { basis: null }))).toEqual([]);
  });

  it('is about counterfactuals only', () => {
    expect(checkModelBasisOverclaim(proposal('signal', { basis: 'measured' }))).toEqual([]);
    expect(
      checkModelBasisOverclaim(proposal('recommendation', { basis: 'deterministic_estimate' })),
    ).toEqual([]);
  });

  it('says nothing about a value that is not an object', () => {
    expect(checkModelBasisOverclaim(null)).toEqual([]);
    expect(checkModelBasisOverclaim('measured')).toEqual([]);
  });
});
