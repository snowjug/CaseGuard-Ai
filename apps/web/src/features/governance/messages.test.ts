import { describe, expect, it } from 'vitest';
import { auditQuery, activeAuditFilters, AUDIT_FILTERS } from './audit-filters';
import {
  NOTE_KEY,
  WHOLE_KEY,
  deepEqual,
  friendlyMessage,
  getIn,
  issuesToErrors,
  setIn,
} from './messages';
import { reviewTargetHref } from './ReviewsPanel';

describe('[FR-GOV-01] dotted-path helpers', () => {
  const value = {
    a: { b: [{ c: 1 }, { c: 2 }] },
    limits: { x: null as number | null },
  };

  it('reads nested objects and array items, and is undefined for anything missing', () => {
    expect(getIn(value, 'a.b.1.c')).toBe(2);
    expect(getIn(value, 'limits.x')).toBeNull();
    expect(getIn(value, 'a.z.y')).toBeUndefined();
    expect(getIn(null, 'a')).toBeUndefined();
  });

  it('sets a value without mutating the original and shares untouched branches', () => {
    const next = setIn(value, 'a.b.0.c', 9);
    expect(getIn(next, 'a.b.0.c')).toBe(9);
    expect(getIn(value, 'a.b.0.c')).toBe(1);
    expect(next.limits).toBe(value.limits);
    expect(Array.isArray(next.a.b)).toBe(true);
    expect(setIn(value, 'limits.x', 5).limits.x).toBe(5);
  });

  it('creates the path when it does not exist', () => {
    expect(getIn(setIn({}, 'one.two', 3), 'one.two')).toBe(3);
  });

  it('compares structurally, treating key order as irrelevant', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: null }, { a: undefined })).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe('[FR-GOV-02] validation messages', () => {
  it('turns the standard Zod sentences into instructions and leaves unknown ones alone', () => {
    expect(friendlyMessage('Too small: expected number to be >=256')).toBe('Enter 256 or more.');
    expect(friendlyMessage('Too big: expected number to be <=200000')).toBe(
      'Enter 200000 or less.',
    );
    expect(friendlyMessage('Invalid input: expected number, received NaN')).toBe('Enter a number.');
    expect(friendlyMessage('Invalid input: expected int, received number')).toBe(
      'Enter a whole number.',
    );
    expect(friendlyMessage('Too small: expected string to have >=1 characters')).toBe(
      'Enter at least 1 character.',
    );
    expect(friendlyMessage('Too big: expected string to have <=60 characters')).toBe(
      'Use at most 60 characters.',
    );
    expect(friendlyMessage('Too big: expected array to have <=20 items')).toBe(
      'At most 20 items are allowed.',
    );
    expect(friendlyMessage('Bands must descend: strong > adequate > needsAttention.')).toBe(
      'Bands must descend: strong > adequate > needsAttention.',
    );
  });

  it('keys client issues by dotted path and API issues without the body.value prefix', () => {
    expect(
      issuesToErrors([
        {
          path: ['agentBudgets', 'quality_judge', 'maxRetries'],
          message: 'Too big: expected number to be <=5',
        },
        {
          path: ['agentBudgets', 'quality_judge', 'maxRetries'],
          message: 'second message is ignored',
        },
        { path: [], message: 'Invalid input' },
      ]),
    ).toEqual({
      'agentBudgets.quality_judge.maxRetries': 'Enter 5 or less.',
      [WHOLE_KEY]: 'Invalid input',
    });
    expect(
      issuesToErrors([
        {
          path: 'body.value.customPatterns.0.pattern',
          message: 'Nested repetition is not allowed.',
        },
        { path: 'body.changeNote', message: 'Describe the change in at least 5 characters.' },
        { path: 'body.value', message: 'Whole value problem' },
      ]),
    ).toEqual({
      'customPatterns.0.pattern': 'Nested repetition is not allowed.',
      [NOTE_KEY]: 'Describe the change in at least 5 characters.',
      [WHOLE_KEY]: 'Whole value problem',
    });
  });
});

describe('[FR-GOV-03] audit filters in the URL', () => {
  it('leaves unset filters out of the query and turns a day into its UTC bounds', () => {
    const base = { act: '', actor: '', acase: null, aout: 'all', afrom: '', ato: '' } as const;
    expect(auditQuery(base)).toEqual({ limit: 50 });
    expect(
      auditQuery({
        act: ' skill.published ',
        actor: 'user_alex_admin',
        acase: 'case_1',
        aout: 'denied',
        afrom: '2025-03-01',
        ato: '2025-03-02',
      }),
    ).toEqual({
      limit: 50,
      action: 'skill.published',
      actorId: 'user_alex_admin',
      caseId: 'case_1',
      outcome: 'denied',
      from: '2025-03-01T00:00:00.000Z',
      to: '2025-03-02T23:59:59.999Z',
    });
    expect(activeAuditFilters({ ...base, aout: 'failure', act: 'x' })).toBe(2);
  });

  it('parses hostile URL values to safe defaults', () => {
    expect(AUDIT_FILTERS.aout.parse('nonsense')).toBe('all');
    expect(AUDIT_FILTERS.afrom.parse('2025-13-45')).toBe('');
    expect(AUDIT_FILTERS.afrom.parse('2025-03-14')).toBe('2025-03-14');
    expect(AUDIT_FILTERS.act.parse('x'.repeat(500))).toHaveLength(80);
    expect(AUDIT_FILTERS.afrom.serialize('')).toBeNull();
  });
});

describe('[FR-GOV-04] reviewer decision links', () => {
  it('links each decision to the page that shows the decided item, or to nothing when there is none', () => {
    expect(reviewTargetHref({ caseId: 'case_1', targetType: 'claim', targetId: 'clm_1' })).toBe(
      '/cases/case_1/evidence?sel=clm_1',
    );
    expect(
      reviewTargetHref({ caseId: 'case_1', targetType: 'counterfactual', targetId: 'scn_1' }),
    ).toBe('/cases/case_1/counterfactual?sel=scn_1');
    expect(reviewTargetHref({ caseId: 'case_1', targetType: 'fork', targetId: 'frk_1' })).toBe(
      '/cases/case_1/counterfactual?sel=frk_1',
    );
    expect(
      reviewTargetHref({ caseId: 'case_1', targetType: 'hypothesis', targetId: 'hyp_1' }),
    ).toBe('/cases/case_1/hypotheses?sel=hyp_1');
    expect(reviewTargetHref({ caseId: 'case_1', targetType: 'warning', targetId: 'w_1' })).toBe(
      '/cases/case_1/quality',
    );
    expect(reviewTargetHref({ caseId: null, targetType: 'skill', targetId: 'skl_1' })).toBe(
      '/skills/skl_1',
    );
    expect(reviewTargetHref({ caseId: null, targetType: 'claim', targetId: 'clm_1' })).toBeNull();
    expect(
      reviewTargetHref({ caseId: 'case_1', targetType: 'skill_version', targetId: 'v' }),
    ).toBeNull();
  });
});
