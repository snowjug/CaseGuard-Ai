import { describe, expect, it } from 'vitest';
import type { Critique } from '@caseguard/schemas';
import { checkFutureInformation } from '../../../src/reasoning/rules/future-information';
import { FUTURE_EVENT_ID, parsed, ruleContext } from '../fixtures';

const ctx = ruleContext();
const found = (p: ReturnType<typeof parsed>) =>
  checkFutureInformation(p, ctx).map((i) => [i.code, i.path]);

describe('rule future_information', () => {
  it('lets a proposal that rests on what was known through', () => {
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

  it('reports a citation of an event after the temporal boundary', () => {
    expect(found(parsed('signal', { eventId: FUTURE_EVENT_ID }))).toEqual([
      ['future_information', 'eventId'],
    ]);
    expect(
      found(
        parsed('recommendation', {
          evidence: [
            { eventId: FUTURE_EVENT_ID, excerpt: 'The resolver at returned stale records' },
          ],
        }),
      ),
    ).toEqual([['future_information', 'evidence[0].eventId']]);
  });

  it('reports, for a missed step, every event cited that came after its decision', () => {
    // The decision is e4; e5 happened after it.
    expect(
      found(
        parsed('missed_step', {
          evidence: [{ eventId: 'e5', excerpt: 'We cleared the Teams cache on five PCs' }],
        }),
      ),
    ).toEqual([['future_information', 'evidence[0].eventId']]);
  });

  it('allows the decision event itself as evidence but not as something already known', () => {
    expect(
      found(
        parsed('missed_step', {
          evidence: [
            { eventId: 'e4', excerpt: 'Revoked sign-in sessions for the 140 affected users' },
          ],
        }),
      ),
    ).toEqual([]);
    expect(found(parsed('missed_step', { availableEventIds: ['e1', 'e4'] }))).toEqual([
      ['future_information', 'availableEventIds[1]'],
    ]);
    expect(found(parsed('missed_step', { availableEventIds: ['e5'] }))).toEqual([
      ['future_information', 'availableEventIds[0]'],
    ]);
  });

  it('holds a counterfactual and a missing-evidence claim to the same moment, notes included', () => {
    const later = { eventId: 'e5', note: 'The cache clear changed nothing.' };
    expect(found(parsed('counterfactual', { contradictions: [later] }))).toEqual([
      ['future_information', 'contradictions[0].eventId'],
    ]);
    expect(
      found(
        parsed('missing_evidence', {
          neededByEventId: 'e3',
          evidence: [
            { eventId: 'e4', excerpt: 'Revoked sign-in sessions for the 140 affected users' },
          ],
        }),
      ),
    ).toEqual([['future_information', 'evidence[0].eventId']]);
  });

  it('does not tie a signal or a contradiction to its own event: the view is the boundary', () => {
    // What came later may legitimately cut against a signal.
    expect(
      found(
        parsed('signal', {
          eventId: 'e3',
          contradictions: [{ eventId: 'e5', note: 'Later events differ.' }],
        }),
      ),
    ).toEqual([]);
  });

  it('reports an identifier that exists only after the boundary', () => {
    expect(
      found(parsed('recommendation', { rationale: 'Check the resolver at 10.20.30.40 first.' })),
    ).toEqual([['future_information', '$']]);
  });

  it('reports wording copied from after the boundary', () => {
    const issues = found(
      parsed('recommendation', {
        rationale: 'It returned stale records for the identity endpoint as expected.',
      }),
    );
    expect(issues).toEqual([['future_information', 'rationale']]);
  });

  it('works without a leak guard, and then checks only what the events say', () => {
    const noGuard = ruleContext({ leakGuard: null, futureEventIds: new Set() });
    expect(
      checkFutureInformation(
        parsed('recommendation', { rationale: 'Check the resolver at 10.20.30.40 first.' }),
        noGuard,
      ),
    ).toEqual([]);
    expect(
      checkFutureInformation(
        parsed('missed_step', {
          evidence: [{ eventId: 'e5', excerpt: 'We cleared the Teams cache' }],
        }),
        noGuard,
      ),
    ).toHaveLength(1);
  });

  it('applies to the quotations of a critique as well', () => {
    const critique: Critique = {
      targetId: 'C1',
      kind: 'unsupported_claim',
      explanation: 'Later text says otherwise.',
      evidence: [{ eventId: FUTURE_EVENT_ID, excerpt: 'The resolver at returned stale records' }],
      alternativeHypothesisId: null,
    };
    expect(checkFutureInformation(critique, ctx).map((i) => [i.code, i.path])).toEqual([
      ['future_information', 'evidence[0].eventId'],
    ]);
  });
});
