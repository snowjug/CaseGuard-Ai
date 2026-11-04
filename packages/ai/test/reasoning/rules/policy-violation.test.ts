import { describe, expect, it } from 'vitest';
import { checkPolicyViolation } from '../../../src/reasoning/rules/policy-violation';
import { parsed, ruleContext } from '../fixtures';

const ctx = ruleContext();
const found = (p: ReturnType<typeof parsed>, c = ctx) =>
  checkPolicyViolation(p, c).map((i) => [i.code, i.path]);

describe('rule policy_violation', () => {
  it('lets ordinary findings and safe advice through', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      expect(found(parsed(type))).toEqual([]);
    }
  });

  it('refuses a missed step that names a destructive, approval-required or too risky action', () => {
    const issues = checkPolicyViolation(
      parsed('missed_step', { actionId: 'act.revoke-user-sessions' }),
      ctx,
    );
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['policy_violation']));
    expect(issues.map((i) => i.message).join(' ')).toMatch(/destructive/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/requires approval/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/risk ceiling/);
  });

  it('applies the risk ceiling of the context', () => {
    const strict = ruleContext({
      policy: {
        riskCeiling: 0.01,
        actions: new Map([
          [
            'act.dns-resolver-comparison',
            { destructive: false, requiresApproval: false, operationalRisk: 0.05 },
          ],
        ]),
      },
    });
    expect(found(parsed('missed_step'), strict)).toEqual([['policy_violation', 'actionId']]);
  });

  it('does not judge an action the pack does not hold (that is unknown_vocabulary_id) or no action', () => {
    expect(found(parsed('missed_step', { actionId: 'act.unknown' }))).toEqual([]);
    expect(found(parsed('missed_step', { actionId: null }))).toEqual([]);
  });

  it.each([
    ['destructive_data_operation', 'Delete the user profiles of the affected users'],
    ['weaken_security', 'Exclude the affected users from the MFA policy'],
    ['mass_credential_reset', 'Reset every user password today'],
    ['auto_close_case', 'Close the case now'],
    ['share_secret', 'Send the customer password by e-mail'],
    ['approval_bypass', 'Proceed without approval from the manager'],
  ])('refuses advice that breaks the safety policy (%s): %s', (_rule, action) => {
    expect(found(parsed('recommendation', { action }))).toEqual([['policy_violation', 'action']]);
    expect(found(parsed('recommendation', { rationale: action }))).toEqual([
      ['policy_violation', 'rationale'],
    ]);
    expect(found(parsed('missed_step', { step: action }))).toEqual([['policy_violation', 'step']]);
    expect(found(parsed('counterfactual', { alternativeAction: action }))).toEqual([
      ['policy_violation', 'alternativeAction'],
    ]);
  });

  it('allows the same words when they forbid the thing', () => {
    expect(found(parsed('recommendation', { action: 'Do not delete the logs' }))).toEqual([]);
    expect(
      found(parsed('recommendation', { action: 'Never close the case without the customer' })),
    ).toEqual([]);
  });

  it('reads advice fields only: a description of what happened is not advice', () => {
    expect(
      found(parsed('signal', { statement: 'The engineer deleted the user profiles.' })),
    ).toEqual([]);
    expect(found(parsed('recommendation', { statement: 'Delete the user profiles.' }))).toEqual([]);
  });

  it.each([
    'The engineer is incompetent.',
    'The engineer should be disciplined.',
    'Rank the engineers by response time.',
  ])('refuses wording that judges individuals, in any text: %s', (statement) => {
    expect(found(parsed('signal', { statement }))).toEqual([['policy_violation', 'statement']]);
    expect(found(parsed('case_synthesis', { summary: statement }))).toEqual([
      ['policy_violation', 'summary'],
    ]);
  });

  it('describes the process, not the person', () => {
    expect(
      found(parsed('signal', { statement: 'The triage named a cause before any log was read.' })),
    ).toEqual([]);
  });

  it('applies to the text of a critique too', () => {
    const critique = {
      targetId: 'C1',
      kind: 'unsupported_claim' as const,
      explanation: 'The engineer is incompetent.',
      evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
      alternativeHypothesisId: null,
    };
    expect(checkPolicyViolation(critique, ctx).map((i) => i.path)).toEqual(['explanation']);
  });

  it('never repeats the text of the proposal in its message', () => {
    const issues = checkPolicyViolation(
      parsed('recommendation', { action: 'Delete the user profiles for CONTOSO-SECRET' }),
      ctx,
    );
    expect(JSON.stringify(issues)).not.toContain('CONTOSO-SECRET');
  });
});
