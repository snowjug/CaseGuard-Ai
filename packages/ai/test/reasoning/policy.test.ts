import { describe, expect, it } from 'vitest';
import {
  AiFindingSchema,
  FINDING_SCHEMA_VERSION,
  PROPOSAL_SCHEMAS,
  type CritiqueKind,
} from '@caseguard/schemas';
import { buildConclusions } from '../../src/reasoning/conclusions';
import {
  combine,
  critiquesOfEngine,
  findingKey,
  stanceOf,
  type ConclusionRef,
  type CriticInput,
} from '../../src/reasoning/policy';
import { locateCitation } from '../../src/reasoning/locate';
import type { KeptCritic, KeptProposal } from '../../src/reasoning/types';
import { conflictBetween, plainFacts } from './facts-fixture';
import { PROVENANCE, criticResult, keptFixture, ruleContext } from './fixtures';
const decide = (
  proposals: KeptProposal[],
  facts = plainFacts(),
  critic: CriticInput | null = null,
) => combine({ proposals, critic, facts, provenance: PROVENANCE });

const only = <T>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
};

/** A critic's kept critiques, located in the fixture events. */
function criticOf(
  critiques: {
    targetId: string | null;
    kind: CritiqueKind;
    eventId?: string;
    excerpt?: string;
    alternativeHypothesisId?: string | null;
  }[],
): KeptCritic {
  const ctx = ruleContext();
  const kept = critiques.map((c) => {
    const eventId = c.eventId ?? 'e2';
    const excerpt = c.excerpt ?? 'Likely a Conditional Access policy issue.';
    const event = ctx.events.get(eventId);
    const located = event ? locateCitation(event, { eventId, excerpt }) : null;
    if (!located) throw new Error('fixture quotation not found');
    return {
      critique: {
        targetId: c.targetId,
        kind: c.kind,
        explanation: 'The record does not support the statement as worded.',
        evidence: [{ eventId, excerpt }],
        alternativeHypothesisId: c.alternativeHypothesisId ?? null,
      },
      evidence: [located],
    };
  });
  const result = PROPOSAL_SCHEMAS.critic_result.parse(criticResult());
  return { result: result, evidence: [], critiques: kept };
}

const REFS: ConclusionRef[] = [
  { id: 'C1', source: 'engine', ref: 'hypothesis:hyp.conditional-access' },
  { id: 'C2', source: 'model', ref: 's1' },
  { id: 'C3', source: 'model', ref: 'r1' },
];

describe('hybrid policy: how a proposal stands next to the engine', () => {
  describe('signal', () => {
    it('is MODEL_CORROBORATED when the engine observed the same signal on a cited event', () => {
      const finding = only(decide([keptFixture('signal')]));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration).toEqual({
        state: 'corroborated',
        by: [{ kind: 'signal', id: 'obs.1', eventIds: ['e3'] }],
      });
      expect(finding.modelOnly).toBe(false);
      expect(finding.reviewRequired).toBe(false);
    });

    it('is MODEL_PROPOSED, model only and for review, when the engine did not observe it', () => {
      const finding = only(decide([keptFixture('signal')], plainFacts({ signals: [] })));
      expect(finding.hybridStatus).toBe('MODEL_PROPOSED');
      expect(finding.deterministicCorroboration).toEqual({ state: 'not_found', by: [] });
      expect(finding.modelOnly).toBe(true);
      expect(finding.reviewRequired).toBe(true);
    });

    it('does not count an observation on an event the proposal does not cite', () => {
      const facts = plainFacts({
        signals: [
          { id: 'obs.9', signalId: 'sig.mfa-ca-events-in-logs', eventId: 'e5', modality: null },
        ],
      });
      expect(only(decide([keptFixture('signal')], facts)).hybridStatus).toBe('MODEL_PROPOSED');
    });

    it.each(['negated', 'speculative', 'future_intent', 'conditional', 'requested'] as const)(
      'is CONFLICTING when the engine reads the statement as %s: both sides are kept',
      (modality) => {
        const facts = plainFacts({
          signals: [
            { id: 'obs.1', signalId: 'sig.mfa-ca-events-in-logs', eventId: 'e3', modality },
          ],
        });
        const finding = only(decide([keptFixture('signal')], facts));
        expect(finding.hybridStatus).toBe('CONFLICTING');
        expect(finding.deterministicCorroboration.state).toBe('conflicts');
        expect(finding.deterministicCorroboration.by).toEqual([
          { kind: 'signal', id: 'obs.1', eventIds: ['e3'] },
        ]);
        expect(finding.modelOnly).toBe(true);
        expect(finding.reviewRequired).toBe(true);
      },
    );

    it('is CONFLICTING when a signal that cannot hold at once holds on a cited event', () => {
      const facts = plainFacts({
        signals: [
          {
            id: 'obs.1',
            signalId: 'sig.mfa-ca-events-in-logs',
            eventId: 'e3',
            modality: 'asserted',
          },
          { id: 'obs.2', signalId: 'sig.ca-config-unchanged', eventId: 'e3', modality: null },
        ],
        signalCounterparts: {
          'sig.mfa-ca-events-in-logs': ['sig.ca-config-unchanged'],
          'sig.ca-config-unchanged': ['sig.mfa-ca-events-in-logs'],
        },
      });
      const finding = only(decide([keptFixture('signal')], facts));
      expect(finding.hybridStatus).toBe('CONFLICTING');
      expect(finding.deterministicCorroboration.by.map((b) => b.id)).toEqual(['obs.2']);
    });

    it('reads an observation with no stated modality as observed', () => {
      expect(only(decide([keptFixture('signal')])).deterministicCorroboration.state).toBe(
        'corroborated',
      );
    });

    it.each(['asserted', 'attributed', 'corrected'] as const)(
      'is MODEL_CORROBORATED when the engine observed the signal as %s, the readings a signal fires on',
      (modality) => {
        const facts = plainFacts({
          signals: [
            { id: 'obs.1', signalId: 'sig.mfa-ca-events-in-logs', eventId: 'e3', modality },
          ],
        });
        expect(only(decide([keptFixture('signal')], facts)).hybridStatus).toBe(
          'MODEL_CORROBORATED',
        );
      },
    );
  });

  describe('contradiction', () => {
    it('is MODEL_PROPOSED when the engine does not look for conflicts (not applicable)', () => {
      const finding = only(decide([keptFixture('contradiction')]));
      expect(finding.deterministicCorroboration.state).toBe('not_applicable');
      expect(finding.hybridStatus).toBe('MODEL_PROPOSED');
      expect(finding.modelOnly).toBe(true);
    });

    it('is MODEL_PROPOSED when the engine looked and found none', () => {
      const finding = only(decide([keptFixture('contradiction')], plainFacts({ conflicts: [] })));
      expect(finding.deterministicCorroboration.state).toBe('not_found');
      expect(finding.hybridStatus).toBe('MODEL_PROPOSED');
    });

    it('is MODEL_CORROBORATED when the engine found a conflict between the same two events', () => {
      const facts = plainFacts({ conflicts: [conflictBetween('e1', 'e2')] });
      const finding = only(decide([keptFixture('contradiction')], facts));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'conflict', id: 'conflict.1', eventIds: ['e1', 'e2'] },
      ]);
    });

    it('does not count a conflict between other events', () => {
      const facts = plainFacts({ conflicts: [conflictBetween('e1', 'e3')] });
      expect(only(decide([keptFixture('contradiction')], facts)).hybridStatus).toBe(
        'MODEL_PROPOSED',
      );
    });
  });

  describe('missing evidence', () => {
    it('is MODEL_CORROBORATED when the requirement mattered and was unmet at the decision', () => {
      const finding = only(decide([keptFixture('missing_evidence')]));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'requirement', id: 'miss.1', eventIds: ['e4'] },
      ]);
    });

    it('is CONFLICTING when the engine saw the requirement met before the decision', () => {
      const base = plainFacts().requirements[0];
      if (!base) throw new Error('fixture');
      const facts = plainFacts({
        requirements: [
          { ...base, resolvedAt: '2026-03-09T10:30:00.000Z', resolvedByEventId: 'e3' },
        ],
      });
      const finding = only(decide([keptFixture('missing_evidence')], facts));
      expect(finding.hybridStatus).toBe('CONFLICTING');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'requirement', id: 'miss.1', eventIds: ['e3'] },
      ]);
    });

    it('stays corroborated when the requirement was met only after the decision', () => {
      const base = plainFacts().requirements[0];
      if (!base) throw new Error('fixture');
      const facts = plainFacts({
        requirements: [
          { ...base, resolvedAt: '2026-03-09T12:30:00.000Z', resolvedByEventId: 'e5' },
        ],
      });
      expect(only(decide([keptFixture('missing_evidence')], facts)).hybridStatus).toBe(
        'MODEL_CORROBORATED',
      );
    });

    it('is MODEL_PROPOSED when it names no pack requirement or the engine has none', () => {
      expect(
        only(decide([keptFixture('missing_evidence', { requirementId: null })])).hybridStatus,
      ).toBe('MODEL_PROPOSED');
      expect(
        only(decide([keptFixture('missing_evidence')], plainFacts({ requirements: [] })))
          .hybridStatus,
      ).toBe('MODEL_PROPOSED');
    });
  });

  describe('missed step', () => {
    it('is MODEL_CORROBORATED when the engine listed the action as an alternative at that decision', () => {
      const finding = only(decide([keptFixture('missed_step')]));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'fork', id: 'fork.1', eventIds: ['e4'] },
      ]);
    });

    it('is CONFLICTING when the engine recognised the action as done by the decision', () => {
      const facts = plainFacts({
        actions: [
          {
            id: 'rec.act.2',
            actionId: 'act.dns-resolver-comparison',
            eventId: 'e3',
            label: 'Compare resolvers',
          },
        ],
      });
      const finding = only(decide([keptFixture('missed_step')], facts));
      expect(finding.hybridStatus).toBe('CONFLICTING');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'action', id: 'rec.act.2', eventIds: ['e3'] },
      ]);
    });

    it('does not count an action done only after the decision', () => {
      const facts = plainFacts({
        actions: [
          {
            id: 'rec.act.2',
            actionId: 'act.dns-resolver-comparison',
            eventId: 'e5',
            label: 'Compare resolvers',
          },
        ],
      });
      expect(only(decide([keptFixture('missed_step')], facts)).hybridStatus).toBe(
        'MODEL_CORROBORATED',
      );
    });

    it('is MODEL_PROPOSED when the engine saw no decision point there', () => {
      expect(
        only(decide([keptFixture('missed_step')], plainFacts({ forks: [] }))).hybridStatus,
      ).toBe('MODEL_PROPOSED');
    });
  });

  describe('counterfactual and recommendation', () => {
    it('a counterfactual the engine does not support needs a person', () => {
      const finding = only(decide([keptFixture('counterfactual')]));
      expect(finding.deterministicCorroboration.state).toBe('not_found');
      expect(finding.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
      expect(finding.modelOnly).toBe(true);
      expect(finding.reviewRequired).toBe(true);
    });

    it('a counterfactual that names an alternative the engine listed at that decision is corroborated', () => {
      const kept = keptFixture('counterfactual', {
        alternativeAction: 'Compare name resolution across the resolvers before revoking anything',
      });
      const finding = only(decide([kept]));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'fork', id: 'fork.1', eventIds: ['e4'] },
      ]);
    });

    it('a counterfactual is not corroborated by an alternative at another decision', () => {
      const kept = keptFixture('counterfactual', {
        decisionEventId: 'e5',
        alternativeAction: 'Compare name resolution across the resolvers',
      });
      expect(only(decide([kept])).hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
    });

    it('a recommendation the engine does not make needs a person', () => {
      const finding = only(decide([keptFixture('recommendation')]));
      expect(finding.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
    });

    it('a recommendation that matches one of the engine on an overlapping event is corroborated', () => {
      const kept = keptFixture('recommendation', {
        action: 'Request a HAR capture from one failing sign-in',
        evidence: [
          { eventId: 'e4', excerpt: 'Revoked sign-in sessions for the 140 affected users' },
        ],
      });
      const finding = only(decide([kept]));
      expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
      expect(finding.deterministicCorroboration.by).toEqual([
        { kind: 'recommendation', id: 'fork:fork.1', eventIds: ['e4'] },
      ]);
    });

    it('a matching recommendation on a different event is not corroboration', () => {
      const kept = keptFixture('recommendation', {
        action: 'Request a HAR capture from one failing sign-in',
      });
      expect(only(decide([kept])).hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
    });
  });

  describe('case synthesis', () => {
    it('is never corroborated: the engine has no counterpart', () => {
      const finding = only(decide([keptFixture('case_synthesis')]));
      expect(finding.deterministicCorroboration.state).toBe('not_applicable');
      expect(finding.hybridStatus).toBe('MODEL_PROPOSED');
      expect(finding.modelOnly).toBe(true);
      expect(finding.reviewRequired).toBe(true);
    });

    it('carries the located quotations of its key points in the payload', () => {
      const finding = only(decide([keptFixture('case_synthesis')]));
      if (finding.type !== 'case_synthesis') throw new Error('type');
      const point = finding.payload.keyPoints[0];
      expect(point?.evidence[0]).toMatchObject({
        eventId: 'e2',
        verified: true,
        verifiedIn: 'stored_text',
      });
    });
  });
});

describe('hybrid policy: what a finding always is', () => {
  const everyType = (): KeptProposal[] => [
    keptFixture('signal'),
    keptFixture('contradiction'),
    keptFixture('missing_evidence'),
    keptFixture('missed_step'),
    keptFixture('counterfactual'),
    keptFixture('recommendation'),
    keptFixture('case_synthesis'),
  ];

  it('is pending, never DETERMINISTIC or REJECTED, and valid against the stored schema', () => {
    const findings = decide(everyType(), plainFacts({ conflicts: [conflictBetween('e1', 'e2')] }));
    expect(findings).toHaveLength(7);
    for (const finding of findings) {
      expect(AiFindingSchema.safeParse(finding).success).toBe(true);
      expect(finding.reviewState).toBe('pending');
      expect(['DETERMINISTIC', 'REJECTED']).not.toContain(finding.hybridStatus);
      expect(finding.schemaVersion).toBe(FINDING_SCHEMA_VERSION);
      expect(finding.provenance).toEqual(PROVENANCE);
      expect(finding.reviewRequired).toBe(finding.hybridStatus !== 'MODEL_CORROBORATED');
      expect(finding.modelOnly).toBe(finding.deterministicCorroboration.state !== 'corroborated');
    }
  });

  it('lists findings by type, then by key, whatever order the proposals came in', () => {
    const forward = decide(everyType());
    const backward = decide(everyType().reverse());
    expect(backward).toEqual(forward);
    expect(forward.map((f) => f.type)).toEqual([
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ]);
  });

  it('derives the id from the content, never from the id the model chose', () => {
    const a = keptFixture('signal', { id: 's1' });
    const b = keptFixture('signal', { id: 'zzz' });
    expect(findingKey(a)).toBe(findingKey(b));
    expect(only(decide([a])).id).toBe(findingKey(a));
    expect(only(decide([a])).id).toMatch(/^fnd_[a-f0-9]{24}$/);
    expect(findingKey(keptFixture('signal', { statement: 'Another statement.' }))).not.toBe(
      findingKey(a),
    );
  });

  it('merges proposals with the same content into one finding', () => {
    expect(
      decide([keptFixture('signal', { id: 's1' }), keptFixture('signal', { id: 's2' })]),
    ).toHaveLength(1);
  });

  it('is idempotent and leaves the facts and the proposals as they were', () => {
    const facts = Object.freeze(
      structuredClone(plainFacts({ conflicts: [conflictBetween('e1', 'e2')] })),
    );
    const before = structuredClone(facts);
    const proposals = everyType();
    const frozen = structuredClone(proposals);
    const first = decide(proposals, facts);
    const second = decide(proposals, facts);
    expect(second).toEqual(first);
    expect(facts).toEqual(before);
    expect(proposals).toEqual(frozen);
  });

  it('gives nothing for no proposals', () => {
    expect(decide([])).toEqual([]);
  });
});

describe('hybrid policy: the critic can only escalate', () => {
  const critique = (targetId: string, kind: CritiqueKind) => ({
    critic: criticOf([{ targetId, kind }]),
    conclusions: REFS,
  });
  const signal = () => keptFixture('signal', { id: 's1' });
  const recommendation = () => keptFixture('recommendation', { id: 'r1' });

  it.each([
    'unsupported_claim',
    'circular_reasoning',
    'premature_closure',
    'counterfactual_overclaim',
    'uncertainty_hidden_as_fact',
    'contradiction',
  ] as const)(
    'a %s critique moves a corroborated finding to NEEDS_HUMAN_REVIEW and stays attached',
    (kind) => {
      const finding = only(decide([signal()], plainFacts(), critique('C2', kind)));
      expect(finding.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
      expect(finding.reviewRequired).toBe(true);
      expect(finding.criticNotes).toHaveLength(1);
      expect(finding.criticNotes[0]).toMatchObject({
        kind,
        evidence: [{ eventId: 'e2', verified: true }],
      });
      expect(finding.deterministicCorroboration.state).toBe('corroborated');
      expect(finding.modelOnly).toBe(false);
    },
  );

  it.each([
    'alternative_explanation',
    'missing_evidence',
    'weak_recommendation',
    'supported',
  ] as const)('a %s critique is a note only: the status does not move', (kind) => {
    const finding = only(decide([signal()], plainFacts(), critique('C2', kind)));
    expect(finding.hybridStatus).toBe('MODEL_CORROBORATED');
    expect(finding.criticNotes).toHaveLength(1);
  });

  it('never makes a finding look better: a favourable critique leaves an unsupported finding as it was', () => {
    const finding = only(decide([recommendation()], plainFacts(), critique('C3', 'supported')));
    expect(finding.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
    const plain = only(decide([recommendation()]));
    expect(finding.hybridStatus).toBe(plain.hybridStatus);
    const proposed = only(
      decide([signal()], plainFacts({ signals: [] }), critique('C2', 'supported')),
    );
    expect(proposed.hybridStatus).toBe('MODEL_PROPOSED');
  });

  it('never lifts a conflict', () => {
    const facts = plainFacts({
      signals: [
        { id: 'obs.1', signalId: 'sig.mfa-ca-events-in-logs', eventId: 'e3', modality: 'negated' },
      ],
    });
    for (const kind of ['supported', 'unsupported_claim'] as const) {
      expect(only(decide([signal()], facts, critique('C2', kind))).hybridStatus).toBe(
        'CONFLICTING',
      );
    }
  });

  it('attaches a critique only to the finding it targets', () => {
    const findings = decide(
      [signal(), recommendation()],
      plainFacts(),
      critique('C3', 'weak_recommendation'),
    );
    expect(findings.find((f) => f.type === 'signal')?.criticNotes).toEqual([]);
    expect(findings.find((f) => f.type === 'recommendation')?.criticNotes).toHaveLength(1);
  });

  it('ignores a critique whose target is not a conclusion of the review', () => {
    const findings = decide([signal()], plainFacts(), {
      critic: criticOf([{ targetId: 'C9', kind: 'unsupported_claim' }]),
      conclusions: REFS,
    });
    expect(only(findings).criticNotes).toEqual([]);
    expect(only(findings).hybridStatus).toBe('MODEL_CORROBORATED');
  });

  it('ignores a critique with no target', () => {
    const findings = decide([signal()], plainFacts(), {
      critic: criticOf([{ targetId: null, kind: 'unsupported_claim' }]),
      conclusions: REFS,
    });
    expect(only(findings).criticNotes).toEqual([]);
  });

  it('a critique of an engine conclusion becomes a note next to the engine item and changes no finding', () => {
    const input = critique('C1', 'unsupported_claim');
    const notes = critiquesOfEngine(input);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      conclusionId: 'C1',
      ref: 'hypothesis:hyp.conditional-access',
      note: { kind: 'unsupported_claim' },
    });
    const withCritic = decide([signal()], plainFacts(), input);
    expect(withCritic).toEqual(decide([signal()]));
  });

  it('gives no engine notes without a critic, and none for a critique of a model finding', () => {
    expect(critiquesOfEngine(null)).toEqual([]);
    expect(critiquesOfEngine({ critic: null, conclusions: REFS })).toEqual([]);
    expect(critiquesOfEngine(critique('C2', 'unsupported_claim'))).toEqual([]);
  });

  it('keeps one note per distinct critique and lists them in a fixed order', () => {
    const critic = criticOf([
      { targetId: 'C2', kind: 'supported' },
      {
        targetId: 'C2',
        kind: 'alternative_explanation',
        alternativeHypothesisId: 'hyp.dns-resolution',
      },
      { targetId: 'C2', kind: 'supported' },
    ]);
    const reversed = { ...critic, critiques: [...critic.critiques].reverse() };
    const a = only(decide([signal()], plainFacts(), { critic, conclusions: REFS }));
    const b = only(decide([signal()], plainFacts(), { critic: reversed, conclusions: REFS }));
    expect(a.criticNotes).toHaveLength(2);
    expect(b.criticNotes).toEqual(a.criticNotes);
    expect(
      a.criticNotes.find((n) => n.kind === 'alternative_explanation')?.alternativeHypothesisId,
    ).toBe('hyp.dns-resolution');
  });
});

describe('stance of a proposal', () => {
  it('is read from the facts only', () => {
    const kept = keptFixture('signal');
    const facts = plainFacts();
    const before = structuredClone(facts);
    expect(stanceOf(kept, facts).state).toBe('corroborated');
    expect(facts).toEqual(before);
  });
});

describe('conclusions under review', () => {
  const proposals = (): KeptProposal[] =>
    [
      keptFixture('recommendation', { id: 'r1' }),
      keptFixture('signal', { id: 's1' }),
    ] as KeptProposal[];

  it('lists the headline of the engine first, then the proposals in type order, numbered C1, C2, ...', () => {
    const list = buildConclusions(plainFacts(), proposals());
    expect(list.map((c) => c.id)).toEqual(list.map((_, i) => `C${i + 1}`));
    const engine = list.filter((c) => c.source === 'engine');
    const model = list.filter((c) => c.source === 'model');
    expect(list.slice(0, engine.length)).toEqual(engine);
    expect(engine.map((c) => c.kind)).toEqual(['leading_hypothesis', 'fork', 'recommendation']);
    expect(model.map((c) => [c.kind, c.ref])).toEqual([
      ['signal', 's1'],
      ['recommendation', 'r1'],
    ]);
  });

  it('is the same whatever the order of the proposals, and carries no server-only text', () => {
    const forward = buildConclusions(plainFacts(), proposals());
    const backward = buildConclusions(plainFacts(), proposals().reverse());
    expect(backward).toEqual(forward);
    expect(JSON.stringify(forward)).not.toMatch(/approved|accepted|hybridStatus/i);
  });

  it('works without any proposals', () => {
    expect(buildConclusions(plainFacts(), []).every((c) => c.source === 'engine')).toBe(true);
    expect(
      buildConclusions(plainFacts({ hypotheses: [], forks: [], recommendations: [] }), []),
    ).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      keptFixture('signal', { id: `s${i}`, statement: `Statement number ${i} about the record.` }),
    );
    expect(buildConclusions(plainFacts(), many).length).toBeLessThanOrEqual(30);
  });
});
