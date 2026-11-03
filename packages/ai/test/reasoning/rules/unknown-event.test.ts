import { describe, expect, it } from 'vitest';
import { checkUnknownEvent } from '../../../src/reasoning/rules/unknown-event';
import { FUTURE_EVENT_ID, parsed, proposal, ruleContext } from '../fixtures';

const ctx = ruleContext();

describe('rule unknown_event', () => {
  it('lets a proposal that cites only events the model was shown through', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      expect(checkUnknownEvent(parsed(type), ctx)).toEqual([]);
    }
  });

  it.each([
    ['the event of a signal', 'signal', { eventId: 'e99' }, 'eventId'],
    [
      'a quotation',
      'signal',
      { evidence: [{ eventId: 'e99', excerpt: 'The sign-in log shows' }] },
      'evidence[0].eventId',
    ],
    ['the decision of a missed step', 'missed_step', { decisionEventId: 'zzz' }, 'decisionEventId'],
    [
      'an event known then',
      'missed_step',
      { availableEventIds: ['e1', 'nope'] },
      'availableEventIds[1]',
    ],
    [
      'the event that needed it',
      'missing_evidence',
      { neededByEventId: 'ghost' },
      'neededByEventId',
    ],
    [
      'a side of a contradiction',
      'contradiction',
      {
        sides: [
          { eventId: 'e1', statement: 'The customer reports it.' },
          { eventId: 'e77', statement: 'The engineer denies it.' },
        ],
      },
      'sides[1].eventId',
    ],
    [
      'a note on what cuts against it',
      'signal',
      { contradictions: [{ eventId: 'e5000', note: 'Opposes it.' }] },
      'contradictions[0].eventId',
    ],
    [
      'a key point of a synthesis',
      'case_synthesis',
      {
        keyPoints: [
          { point: 'P.', evidence: [{ eventId: 'e404', excerpt: 'Likely a Conditional Access' }] },
        ],
      },
      'keyPoints[0].evidence[0].eventId',
    ],
  ] as const)('reports an unknown event as %s', (_name, type, patch, path) => {
    const issues = checkUnknownEvent(proposal(type, patch), ctx);
    expect(issues.map((i) => [i.code, i.path])).toEqual([['unknown_event', path]]);
  });

  it('reports each unknown event once per place', () => {
    const issues = checkUnknownEvent(
      proposal('signal', {
        eventId: 'x1',
        evidence: [
          { eventId: 'x2', excerpt: 'The sign-in log' },
          { eventId: 'e3', excerpt: 'The sign-in log' },
        ],
      }),
      ctx,
    );
    expect(issues.map((i) => i.path)).toEqual(['eventId', 'evidence[0].eventId']);
  });

  it('leaves an event after the boundary to future_information', () => {
    expect(checkUnknownEvent(proposal('signal', { eventId: FUTURE_EVENT_ID }), ctx)).toEqual([]);
  });

  it('knows an event the model was not shown even when the case has it (trimmed away)', () => {
    const trimmed = ruleContext({
      events: new Map([...ruleContext().events].filter(([id]) => id !== 'e5')),
      futureEventIds: new Set([FUTURE_EVENT_ID]),
    });
    expect(checkUnknownEvent(proposal('signal', { eventId: 'e5' }), trimmed)).toHaveLength(1);
  });

  it('never lets a model-chosen id into the message or the path', () => {
    const issues = checkUnknownEvent(
      proposal('signal', { eventId: '<script>alert(1)</script>' }),
      ctx,
    );
    expect(JSON.stringify(issues)).not.toContain('script');
  });
});
