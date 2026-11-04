import type { Conflict } from '@caseguard/schemas';
import type { DeterministicFacts } from '../../src/reasoning/facts';

const BASE = Date.parse('2026-03-09T09:00:00.000Z');
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

/**
 * What the engine concluded about the small fixture case of `fixtures.ts`, as plain data: the policy is tested without
 * the engine. e3 states the sign-in log result, e4 is the decision (sessions revoked), e6 lies after the boundary.
 */
export function plainFacts(overrides: Partial<DeterministicFacts> = {}): DeterministicFacts {
  return {
    eventOrder: {
      e1: { at: at(0), sequence: 0 },
      e2: { at: at(30), sequence: 1 },
      e3: { at: at(90), sequence: 2 },
      e4: { at: at(150), sequence: 3 },
      e5: { at: at(210), sequence: 4 },
      e6: { at: at(300), sequence: 5 },
    },
    signals: [
      { id: 'obs.1', signalId: 'sig.mfa-ca-events-in-logs', eventId: 'e3', modality: null },
    ],
    actions: [
      {
        id: 'rec.act.1',
        actionId: 'act.revoke-user-sessions',
        eventId: 'e4',
        label: 'Revoke user sessions',
      },
    ],
    forks: [
      {
        id: 'fork.1',
        category: 'premature_destructive_action',
        eventId: 'e4',
        title: 'Sessions were revoked before a client trace existed',
        alternativeActionIds: ['act.dns-resolver-comparison', 'act.request-har-capture'],
        alternativeLabels: [
          'Compare name resolution across the resolvers',
          'Request a HAR capture',
        ],
      },
    ],
    requirements: [
      {
        requirementId: 'req.client-diagnostics',
        id: 'miss.1',
        label: 'Client diagnostics',
        criticality: 'critical',
        firstRelevantAt: at(0),
        resolvedAt: null,
        resolvedByEventId: null,
      },
    ],
    hypotheses: [
      {
        hypothesisId: 'hyp.conditional-access',
        name: 'Conditional Access policy',
        rank: 1,
        status: 'leading',
        confidence: 0.6,
        level: 'medium',
      },
    ],
    recommendations: [
      {
        id: 'fork:fork.1',
        actionId: 'act.request-har-capture',
        label: 'Request a HAR capture',
        eventIds: ['e4'],
      },
    ],
    counterfactuals: [],
    conflicts: null,
    signalCounterparts: {},
    ...overrides,
  };
}

/** A conflict between the customer's report (e1) and the triage (e2). */
export function conflictBetween(first: string, second: string, id = 'conflict.1'): Conflict {
  return {
    id,
    class: 'unresolved_conflict',
    subject: 'cause of the failures',
    sides: [
      {
        eventId: first,
        participantRole: 'customer_end_user',
        timestamp: at(0),
        statement: 'The customer reports a name-resolution style error.',
        subject: 'sig.error-name-not-resolved',
        polarity: 'asserts',
        modality: 'asserted',
        sourceRef: { eventId: first },
      },
      {
        eventId: second,
        participantRole: 'support_engineer',
        timestamp: at(30),
        statement: 'The engineer suspects a Conditional Access policy.',
        subject: 'sig.error-name-not-resolved',
        polarity: 'denies',
        modality: 'speculative',
        sourceRef: { eventId: second },
      },
    ],
    favours: null,
    explanation:
      'The two statements point at different causes and nothing settles which one holds.',
    uncertainty: { level: 'medium', note: 'The record does not settle it.' },
    ruleId: 'test.rule',
  };
}
