import { describe, expect, it } from 'vitest';
import {
  validateKnowledgePackReferences,
  type CaseEvent,
  type EventType,
  type ParticipantRole,
} from '@caseguard/schemas';
import {
  TEAMS_AUTH_PACK,
  correctionChangedCause,
  createFullView,
  createTemporalView,
  getCompiledPack,
  rejectedHypothesisReused,
  runDeterministicAnalysis,
  type Observation,
  type SequenceInput,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, contextFor, prepareCase } from './helpers';

const pack = (() => {
  const compiled = getCompiledPack('teams-authentication');
  if (!compiled) throw new Error('the Teams pack is missing');
  return compiled;
})();

let counter = 0;
function ev(
  role: ParticipantRole,
  type: EventType,
  at: string,
  body: string,
  who?: string,
): CaseEvent {
  counter += 1;
  return {
    tenantId: 'tenant_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    version: 1,
    id: `ev_${counter}`,
    caseId: 'case_x',
    sourceId: 'src_x',
    sequence: counter,
    timestamp: `2026-01-01T${at}:00.000Z`,
    participantId: who ?? `p_${role}`,
    participantRole: role,
    participantAlias: role,
    type,
    channel: 'email',
    title: null,
    body,
    action: null,
    inResponseTo: null,
    correlationIds: [],
    structured: null,
    ai: null,
    sourcePointer: `/events/${counter}`,
    redaction: { redacted: false, categories: [] },
    immutable: true,
  };
}

const analyse = (...events: CaseEvent[]) =>
  runDeterministicAnalysis({
    view: createFullView(events, null),
    pack,
    config: CONFIG,
    ctx: contextFor('case_x'),
  });

describe('a signal pair stated from both sides', () => {
  const clear = (who?: string) =>
    ev(
      'customer_admin',
      'customer_email',
      '08:00',
      'Service health shows no incident for Teams.',
      who,
    );
  const incident = (at = '09:00', role: ParticipantRole = 'support_engineer') =>
    ev(
      role,
      'diagnostic_result',
      at,
      'Service health lists an active incident for sign-in and Teams.',
    );

  it('keeps both sides of two people who disagree, and says nothing settles it', () => {
    const a = clear();
    const b = incident();
    const [conflict] = analyse(a, b).conflicts;
    expect(conflict).toMatchObject({
      class: 'unresolved_conflict',
      ruleId: 'different-sources-open',
      favours: null,
    });
    expect(conflict?.sides.map((s) => s.eventId)).toEqual([a.id, b.id]);
    expect(conflict?.sides.map((s) => s.polarity)).toEqual(['denies', 'asserts']);
    expect(conflict?.sides[1].sourceRef.excerpt).toMatch(/active incident|active/i);
  });

  it('is a disagreement between sources, settled, when a later statement takes one side', () => {
    const [conflict] = analyse(
      clear(),
      incident(),
      ev(
        'support_engineer',
        'diagnostic_result',
        '10:00',
        'Service health still lists an active incident.',
      ),
    ).conflicts;
    expect(conflict).toMatchObject({ class: 'source_disagreement', favours: 'second' });
  });

  it('is an update when the same person later describes a state that changes', () => {
    const a = ev(
      'support_engineer',
      'diagnostic_result',
      '08:00',
      'Service health shows no incident for Teams.',
    );
    const [conflict] = analyse(a, incident()).conflicts;
    expect(conflict).toMatchObject({
      class: 'temporal_update',
      ruleId: 'same-source-later-state',
      favours: 'second',
    });
  });

  it('does not report a fault that was found and later reported fixed', () => {
    const first = incident('08:00');
    const later = ev(
      'support_engineer',
      'diagnostic_result',
      '09:00',
      'Service health shows no incident for Teams.',
    );
    expect(analyse(first, later).conflicts).toEqual([]);
  });

  it('calls it a direct contradiction when one person says both about something that does not change', () => {
    const a = ev(
      'customer_admin',
      'customer_email',
      '08:00',
      'Our Conditional Access policy was changed yesterday.',
    );
    const b = ev(
      'customer_admin',
      'customer_email',
      '09:00',
      'The Conditional Access policy has no changes.',
    );
    expect(analyse(a, b).conflicts[0]).toMatchObject({
      class: 'direct_contradiction',
      ruleId: 'same-source-opposite',
    });
  });

  it('calls it a correction when the later statement says so, and ambiguous when it is hedged', () => {
    const a = ev(
      'customer_admin',
      'customer_email',
      '08:00',
      'Our Conditional Access policy was changed yesterday.',
    );
    const corrected = ev(
      'customer_admin',
      'customer_email',
      '09:00',
      'Correction: the Conditional Access policy has no changes.',
    );
    expect(analyse(a, corrected).conflicts[0]).toMatchObject({
      class: 'corrected_information',
      favours: 'second',
    });
    const hedged = ev(
      'customer_admin',
      'customer_email',
      '09:00',
      'It seems the Conditional Access policy has no changes.',
    );
    expect(analyse(a, hedged).conflicts[0]).toMatchObject({
      class: 'ambiguous_wording',
      favours: null,
    });
  });

  it('reports a change once, however many statements repeat the new side', () => {
    expect(
      analyse(clear(), incident('09:00', 'support_engineer'), incident('09:30')).conflicts,
    ).toHaveLength(1);
    expect(
      analyse(
        ev(
          'customer_admin',
          'customer_email',
          '08:00',
          'Service health shows no incident for Teams.',
        ),
        ev(
          'support_engineer',
          'diagnostic_result',
          '08:30',
          'Service health shows no incident for Teams.',
        ),
      ).conflicts,
    ).toEqual([]);
  });
});

describe('an attribute stated with two values', () => {
  it('is an update for one person and a disagreement for two', () => {
    const a = ev('customer_admin', 'customer_email', '08:00', 'About 45 users are affected.');
    const b = ev('customer_admin', 'customer_email', '09:00', 'Now 120 users are affected.');
    const c = ev('customer_end_user', 'customer_email', '10:00', 'Only 12 people are affected.');
    const { conflicts } = analyse(a, b, c);
    expect(conflicts.map((x) => x.class)).toEqual(['temporal_update', 'unresolved_conflict']);
    expect(conflicts[0]?.sides.map((s) => s.sourceRef.excerpt)).toEqual(['45 users', '120 users']);
  });
});

describe('a conclusion that needs more than one event', () => {
  it('notices a request the customer never answered before the case was escalated', () => {
    const request = ev(
      'support_engineer',
      'engineer_email',
      '08:00',
      'Please clear the Teams cache and sign in again.',
    );
    const escalation = ev(
      'support_engineer',
      'escalation',
      '09:00',
      'Escalating to the identity team for review.',
    );
    const { sequenceFindings } = analyse(request, escalation);
    const found = sequenceFindings.find((f) => f.rule === 'requested_never_completed');
    expect(found).toBeDefined();
    expect(found?.asOf).toBe(escalation.timestamp);
    expect(found?.events.map((e) => e.eventId)).toEqual([request.id, escalation.id]);

    const reply = ev('customer_end_user', 'customer_email', '08:30', 'Will do.');
    expect(
      analyse(request, reply, escalation).sequenceFindings.some(
        (f) => f.rule === 'requested_never_completed',
      ),
    ).toBe(false);
  });

  it('notices a low-risk step taken only after the escalation, when everything it needs was already known', () => {
    const facts = ev(
      'customer_admin',
      'customer_email',
      '08:00',
      'Users: a.kowal@example.test at 08:14:10 UTC and m.nowak@example.test at 08:16:55 UTC.',
    );
    const escalation = ev(
      'support_engineer',
      'escalation',
      '09:00',
      'Escalating to the identity team.',
    );
    const step = ev(
      'support_engineer',
      'engineer_action',
      '10:00',
      'Checked the SigninLogs for both users.',
    );
    const found = analyse(facts, escalation, step).sequenceFindings.find(
      (f) => f.rule === 'step_only_after_escalation',
    );
    expect(found?.asOf).toBe(step.timestamp);
    expect(found?.events.map((e) => e.role)).toEqual(['escalation', 'step taken afterwards']);
  });

  it('notices a step asked for again after the reply said it did not help', () => {
    const first = ev(
      'support_engineer',
      'engineer_email',
      '08:00',
      'Please clear the Teams cache on one PC.',
    );
    const reply = ev(
      'customer_end_user',
      'customer_email',
      '09:00',
      'We cleared the cache and it still fails.',
    );
    const again = ev(
      'support_engineer',
      'engineer_email',
      '10:00',
      'Please clear the Teams cache once more.',
    );
    const { sequenceFindings, observations } = analyse(first, reply, again);
    const found = sequenceFindings.find((f) => f.rule === 'failed_step_repeated');
    expect(found?.events.map((e) => e.eventId)).toEqual([first.id, reply.id, again.id]);
    const outcome = observations.find(
      (o) => o.eventId === reply.id && o.signalId === 'sig.cache-clear-no-effect',
    );
    expect(found?.evidenceIds).toEqual([outcome?.id]);
  });

  it('does not call a different step a repeat, nor a step that was only denied', () => {
    const first = ev(
      'support_engineer',
      'engineer_email',
      '08:00',
      'Please clear the Teams cache on one PC.',
    );
    const reply = ev(
      'customer_end_user',
      'customer_email',
      '09:00',
      'We cleared the cache and it still fails.',
    );
    const other = ev(
      'support_engineer',
      'engineer_email',
      '10:00',
      'Please send a HAR capture of one failure.',
    );
    const denied = ev(
      'support_engineer',
      'engineer_email',
      '11:00',
      'Do not clear the Teams cache again.',
    );
    const { sequenceFindings } = analyse(first, reply, other, denied);
    expect(sequenceFindings.some((f) => f.rule === 'failed_step_repeated')).toBe(false);
  });
});

/** A minimal input for the rules that read the belief timeline, with the posteriors the test states. */
function inputWith(
  events: CaseEvent[],
  posteriors: Record<string, number>[],
  observations: Observation[] = [],
): SequenceInput {
  const view = createFullView(events, null);
  return {
    view,
    pack,
    caseId: 'case_x',
    observations,
    timeline: {
      prior: posteriors[0] ?? {},
      steps: view.events.map((event, eventIndex) => ({
        eventIndex,
        eventId: event.id,
        at: event.timestamp,
        posterior: posteriors[eventIndex] ?? {},
        low: {},
        high: {},
        effects: [],
        gainBits: 0,
      })),
    },
    requirementStates: [],
    forks: [],
  };
}

describe('a cause the evidence had ruled out, and a correction that changed it', () => {
  it('notices a step that tests a hypothesis after its probability had fallen below five percent', () => {
    const e0 = ev('customer_admin', 'customer_email', '08:00', 'Sign-ins fail.');
    const e1 = ev('customer_admin', 'customer_email', '08:30', 'The browser version fails too.');
    const e2 = ev(
      'support_engineer',
      'engineer_email',
      '09:00',
      'Please clear the Teams cache once more.',
    );
    const input = inputWith(
      [e0, e1, e2],
      [{ 'hyp.client-cache': 0.3 }, { 'hyp.client-cache': 0.02 }, { 'hyp.client-cache': 0.02 }],
    );
    const [found] = rejectedHypothesisReused(input);
    expect(found?.events.map((e) => e.eventId)).toEqual([e1.id, e2.id]);
    expect(found?.asOf).toBe(e2.timestamp);
  });

  it('says nothing about a hypothesis that was never plausible', () => {
    const e0 = ev('customer_admin', 'customer_email', '08:00', 'Sign-ins fail.');
    const e1 = ev(
      'support_engineer',
      'engineer_email',
      '09:00',
      'Please clear the Teams cache once more.',
    );
    expect(
      rejectedHypothesisReused(
        inputWith([e0, e1], [{ 'hyp.client-cache': 0.03 }, { 'hyp.client-cache': 0.02 }]),
      ),
    ).toEqual([]);
  });

  it('reports a correction only when the leading cause changes after it', () => {
    const e0 = ev('customer_admin', 'customer_email', '08:00', 'Sign-ins fail.');
    const e1 = ev('customer_admin', 'customer_email', '09:00', 'Correction: it is one site only.');
    const corrected = {
      id: 'obs_1',
      signalId: 'sig.site-correlated',
      eventId: e1.id,
      eventIndex: 1,
      modality: 'corrected',
    } as Observation;
    const changed = inputWith(
      [e0, e1],
      [
        { 'hyp.dns-resolution': 0.5, 'hyp.proxy-egress': 0.2 },
        { 'hyp.dns-resolution': 0.2, 'hyp.proxy-egress': 0.6 },
      ],
      [corrected],
    );
    expect(correctionChangedCause(changed)[0]).toMatchObject({
      rule: 'customer_correction_changed_cause',
      evidenceIds: ['obs_1'],
    });
    const same = inputWith(
      [e0, e1],
      [
        { 'hyp.dns-resolution': 0.5, 'hyp.proxy-egress': 0.2 },
        { 'hyp.dns-resolution': 0.6, 'hyp.proxy-egress': 0.2 },
      ],
      [corrected],
    );
    expect(correctionChangedCause(same)).toEqual([]);
  });
});

describe('nothing is concluded from events after the view', () => {
  for (const file of [CASE_ONE, CASE_TWO]) {
    it(`${file}: a view cut at any event has exactly the findings anchored at or before the cut`, () => {
      const full = prepareCase(file);
      const events = full.normalized.events;
      for (const cutAt of events) {
        const cut = cutAt.timestamp;
        const partial = runDeterministicAnalysis({
          view: createTemporalView(events, cut),
          pack: full.pack,
          config: CONFIG,
          ctx: full.ctx,
        });
        const expected = full.analysis.sequenceFindings
          .filter((f) => f.asOf <= cut)
          .map((f) => f.id);
        expect(partial.sequenceFindings.map((f) => f.id).sort(), `${file} at ${cut}`).toEqual(
          expected.sort(),
        );
        for (const f of partial.sequenceFindings) expect(f.asOf <= cut).toBe(true);
        for (const c of partial.conflicts) expect(c.sides[1].timestamp <= cut).toBe(true);
      }
    });
  }
});

describe('declared signal pairs', () => {
  it('are consistent in the shipped pack, and each signal is in at most one pair', () => {
    expect(validateKnowledgePackReferences(TEAMS_AUTH_PACK)).toEqual([]);
    expect(pack.signalPairs.size).toBe(TEAMS_AUTH_PACK.signalPairs.length * 2);
  });

  it('are refused when they name an unknown signal, one signal twice, or one signal on both sides', () => {
    const [first] = TEAMS_AUTH_PACK.signalPairs;
    if (!first) throw new Error('expected a signal pair');
    const withPair = (pair: (typeof TEAMS_AUTH_PACK.signalPairs)[number]) =>
      validateKnowledgePackReferences({
        ...TEAMS_AUTH_PACK,
        signalPairs: [...TEAMS_AUTH_PACK.signalPairs, pair],
      });
    expect(withPair({ ...first, id: 'pair.x', positive: 'sig.nope' }).join('\n')).toMatch(
      /unknown signal sig\.nope/,
    );
    expect(withPair({ ...first, id: 'pair.y' }).join('\n')).toMatch(/more than one signal pair/);
    expect(
      withPair({
        ...first,
        id: 'pair.z',
        positive: 'sig.error-timeout',
        negative: 'sig.error-timeout',
      }).join('\n'),
    ).toMatch(/both sides/);
  });
});
