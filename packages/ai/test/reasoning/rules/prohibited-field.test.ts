import { describe, expect, it } from 'vitest';
import { PROHIBITED_MODEL_FIELDS } from '@caseguard/schemas';
import { checkProhibitedField } from '../../../src/reasoning/rules/prohibited-field';
import { proposal } from '../fixtures';

describe('rule prohibited_field', () => {
  it('lets a proposal that names no server-only field through', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      expect(checkProhibitedField(proposal(type))).toEqual([]);
    }
  });

  it.each(PROHIBITED_MODEL_FIELDS)('reports %s, at the top and inside a citation', (name) => {
    const top = checkProhibitedField(proposal('signal', { [name]: true }));
    expect(top.map((i) => i.code)).toEqual(['prohibited_field']);
    expect(top[0]?.path).toBe(name);
    const nested = checkProhibitedField(
      proposal('signal', {
        evidence: [{ eventId: 'e3', excerpt: 'The sign-in log shows', [name]: 1 }],
      }),
    );
    expect(nested.map((i) => i.path)).toEqual([`evidence[0].${name}`]);
  });

  it('is not fooled by case, underscores or hyphens', () => {
    const issues = checkProhibitedField(
      proposal('signal', {
        Approved: true,
        review_state: 'accepted',
        'hybrid-status': 'DETERMINISTIC',
      }),
    );
    expect(issues).toHaveLength(3);
  });

  it('is what a self-approval attempt looks like: accepting, approving, claiming the engine agrees', () => {
    const attempts = [
      { accepted: true },
      { approved: true },
      { reviewState: 'accepted' },
      { status: 'accepted' },
      { hybridStatus: 'DETERMINISTIC' },
      { modelOnly: false },
      { validationStatus: 'passed' },
      { deterministicCorroboration: { state: 'corroborated', by: [] } },
    ];
    for (const attempt of attempts) {
      expect(checkProhibitedField(proposal('recommendation', attempt))).toHaveLength(1);
    }
  });

  it('never lets a key the model chose into the path', () => {
    const [issue] = checkProhibitedField({
      'appr<script>oved': true,
      'a b\u0000pproved': true,
      Approved: 1,
    });
    expect(issue?.path).toMatch(/^[A-Za-z0-9_.[\]-]*$/);
    for (const found of checkProhibitedField({ '<img src=x>Approved': true })) {
      expect(found.path).not.toMatch(/[<>=\s]/);
    }
  });

  it('says nothing about a value that is not an object', () => {
    for (const value of [null, undefined, 'approved', 7, [], ['approved']]) {
      expect(checkProhibitedField(value)).toEqual([]);
    }
  });
});
