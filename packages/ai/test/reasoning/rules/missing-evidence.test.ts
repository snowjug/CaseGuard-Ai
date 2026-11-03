import { describe, expect, it } from 'vitest';
import { checkMissingEvidence } from '../../../src/reasoning/rules/missing-evidence';
import { proposal } from '../fixtures';

describe('rule missing_evidence', () => {
  it('lets a proposal with a citation through', () => {
    expect(checkMissingEvidence(proposal('signal'))).toEqual([]);
    expect(checkMissingEvidence(proposal('case_synthesis'))).toEqual([]);
  });

  it.each([
    ['an empty list', []],
    ['nothing', undefined],
    ['null', null],
    ['text instead of a list', 'The sign-in log shows it.'],
  ])('reports %s as evidence', (_name, evidence) => {
    const issues = checkMissingEvidence(proposal('signal', { evidence }));
    expect(issues.map((i) => [i.code, i.path])).toEqual([['missing_evidence', 'evidence']]);
  });

  it('reports a proposal with no evidence key at all', () => {
    const { evidence: _gone, ...without } = proposal('recommendation');
    expect(checkMissingEvidence(without).map((i) => i.code)).toEqual(['missing_evidence']);
  });

  it('reads the key points of a synthesis too', () => {
    const issues = checkMissingEvidence(
      proposal('case_synthesis', {
        keyPoints: [
          {
            point: 'Quoted.',
            evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
          },
          { point: 'Not quoted.', evidence: [] },
        ],
      }),
    );
    expect(issues.map((i) => i.path)).toEqual(['keyPoints[1].evidence']);
  });

  it('is about every type', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      expect(checkMissingEvidence(proposal(type, { evidence: [] })).map((i) => i.code)).toEqual([
        'missing_evidence',
      ]);
    }
  });

  it('says nothing about a value that is not an object', () => {
    expect(checkMissingEvidence(null)).toEqual([]);
    expect(checkMissingEvidence('text')).toEqual([]);
  });
});
