import { describe, expect, it } from 'vitest';
import {
  checkNumericTimeClaim,
  claimsNumericTimeSaving,
} from '../../../src/reasoning/rules/numeric-time-claim';
import { criticResult, parsed } from '../fixtures';
import { PROPOSAL_SCHEMAS } from '@caseguard/schemas';

describe('rule numeric_time_claim', () => {
  it.each([
    'This would have saved 3 hours.',
    'Asking sooner could have saved about two days of waiting.',
    'It reduces the time to resolution by 40%.',
    'Shortening the investigation by two days is plausible.',
    'The delay could have been cut by half an hour.',
    'The 3 days of waiting could have been avoided.',
    'That avoids a 90 minute delay.',
    'The case would have been resolved 2 days earlier.',
    'This might resolve it 20% faster.',
    'It would take half the time.',
    'Saving 15 minutes per sign-in check.',
    'It could save an hour.',
    'The wait would be reduced from 3 days to 1 day.',
  ])('flags a saved time stated as a number: %s', (text) => {
    expect(claimsNumericTimeSaving(text)).toBe(true);
  });

  it.each([
    'This might have saved time.',
    'Asking sooner would have helped.',
    'The customer waited 3 days for an answer.',
    'The engineer replied 2 hours earlier than the customer.',
    'Reduce the query window to the last 24 hours.',
    'Narrow the log query to 7 days.',
    'The failures started 3 days earlier.',
    'About 140 users were affected.',
    'Re-run the query with a 30 minute window.',
    'The two engineers disagreed.',
    'A HAR capture was requested twice.',
  ])('lets ordinary use of numbers and time through: %s', (text) => {
    expect(claimsNumericTimeSaving(text)).toBe(false);
  });

  it('is about what the model wrote, in every field of a counterfactual or a recommendation', () => {
    const claim = 'This would have saved 3 hours.';
    expect(
      checkNumericTimeClaim(parsed('counterfactual', { plausibleDownstreamEffect: claim })).map(
        (i) => [i.code, i.path],
      ),
    ).toEqual([['numeric_time_claim', 'plausibleDownstreamEffect']]);
    expect(
      checkNumericTimeClaim(parsed('recommendation', { rationale: claim })).map((i) => i.path),
    ).toEqual(['rationale']);
    expect(
      checkNumericTimeClaim(parsed('signal', { statement: claim })).map((i) => i.path),
    ).toEqual(['statement']);
  });

  it('does not read a quotation of the record: the record may promise a saving', () => {
    expect(
      checkNumericTimeClaim(
        parsed('recommendation', {
          evidence: [{ eventId: 'e3', excerpt: 'The sign-in log shows AADSTS50076' }],
        }),
      ),
    ).toEqual([]);
    // A record that did say it, quoted verbatim, is still only a quotation.
    const quoted = parsed('case_synthesis');
    expect(checkNumericTimeClaim(quoted)).toEqual([]);
  });

  it('does not read the critic: it may have to repeat a claim it criticises', () => {
    const critic = PROPOSAL_SCHEMAS.critic_result.parse(
      criticResult({
        critiques: [
          {
            targetId: 'C1',
            kind: 'counterfactual_overclaim',
            explanation: 'The claim that it would have saved 3 hours is not supported.',
            evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
            alternativeHypothesisId: null,
          },
        ],
      }),
    );
    expect(checkNumericTimeClaim(critic)).toEqual([]);
  });

  it('works sentence by sentence: a number elsewhere does not turn a plain sentence into a claim', () => {
    expect(claimsNumericTimeSaving('It saves time. The case lasted 3 days.')).toBe(false);
    expect(claimsNumericTimeSaving('The case lasted 3 days. It saved 2 hours.')).toBe(true);
  });
});
