import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CRITIQUE_KINDS,
  ESCALATING_CRITIQUE_KINDS,
  PROPOSAL_SCHEMAS,
  STATEMENT_MODALITIES,
  type AiFinding,
  type CritiqueKind,
  type HybridStatus,
  type StatementModality,
} from '@caseguard/schemas';
import type { DeterministicFacts } from '../../src/reasoning/facts';
import { combine, type ConclusionRef, type CriticInput } from '../../src/reasoning/policy';
import { locateCitation } from '../../src/reasoning/locate';
import type { KeptCritic, KeptProposal } from '../../src/reasoning/types';
import { conflictBetween, plainFacts } from './facts-fixture';
import { PROVENANCE, criticResult, keptFixture, ruleContext } from './fixtures';

const EVENTS = ['e1', 'e2', 'e3', 'e4', 'e5'] as const;
const SIGNALS = [
  'sig.mfa-ca-events-in-logs',
  'sig.error-name-not-resolved',
  'sig.cache-clear-no-effect',
] as const;
const ACTIONS = [
  'act.dns-resolver-comparison',
  'act.request-har-capture',
  'act.revoke-user-sessions',
] as const;
const LABELS: Record<(typeof ACTIONS)[number], string> = {
  'act.dns-resolver-comparison': 'Compare name resolution across the resolvers',
  'act.request-har-capture': 'Request a HAR capture',
  'act.revoke-user-sessions': 'Revoke user sessions',
};
const REQUIREMENTS = ['req.client-diagnostics', 'req.error-code'] as const;
const QUOTES: Record<(typeof EVENTS)[number], string> = {
  e1: 'Users at the Pune office cannot sign in to Teams.',
  e2: 'Likely a Conditional Access policy issue.',
  e3: 'The sign-in log shows AADSTS50076 for the three sample users.',
  e4: 'Revoked sign-in sessions for the 140 affected users',
  e5: 'We cleared the Teams cache on five PCs',
};
const AT = (minutes: number) =>
  new Date(Date.parse('2026-03-09T09:00:00.000Z') + minutes * 60_000).toISOString();

const eventId = fc.constantFrom(...EVENTS);
const modality = fc.constantFrom<StatementModality | null>(null, ...STATEMENT_MODALITIES);

const factsArb: fc.Arbitrary<DeterministicFacts> = fc
  .record({
    signals: fc.array(
      fc.record({
        signalId: fc.constantFrom(...SIGNALS),
        eventId,
        modality,
      }),
      { maxLength: 6 },
    ),
    actions: fc.array(
      fc.record({ actionId: fc.constantFrom<string | null>(null, ...ACTIONS), eventId }),
      { maxLength: 4 },
    ),
    forks: fc.array(fc.record({ eventId, alternatives: fc.subarray([...ACTIONS]) }), {
      maxLength: 3,
    }),
    requirements: fc.array(
      fc.record({
        requirementId: fc.constantFrom(...REQUIREMENTS),
        relevantMinutes: fc.integer({ min: 0, max: 200 }),
        resolvedBy: fc.constantFrom<(typeof EVENTS)[number] | null>(null, ...EVENTS),
      }),
      { maxLength: 3 },
    ),
    conflicts: fc.option(fc.array(fc.tuple(eventId, eventId), { maxLength: 3 }), { nil: null }),
    counterparts: fc.boolean(),
    recommendations: fc.array(
      fc.record({
        action: fc.constantFrom(...ACTIONS),
        eventIds: fc.subarray([...EVENTS]),
      }),
      { maxLength: 3 },
    ),
  })
  .map((spec) =>
    plainFacts({
      signals: spec.signals.map((s, i) => ({ id: `obs.${i}`, ...s })),
      actions: spec.actions.map((a, i) => ({ id: `rec.act.${i}`, label: 'An action', ...a })),
      forks: spec.forks.map((f, i) => ({
        id: `fork.${i}`,
        category: 'premature_destructive_action' as const,
        eventId: f.eventId,
        title: 'A decision point',
        alternativeActionIds: f.alternatives,
        alternativeLabels: f.alternatives.map((id) => LABELS[id]),
      })),
      requirements: spec.requirements.map((r, i) => ({
        requirementId: r.requirementId,
        id: `miss.${i}`,
        label: 'A requirement',
        criticality: 'critical' as const,
        firstRelevantAt: AT(r.relevantMinutes),
        resolvedAt: r.resolvedBy === null ? null : AT(300),
        resolvedByEventId: r.resolvedBy,
      })),
      conflicts:
        spec.conflicts === null
          ? null
          : spec.conflicts.map(([a, b], i) => conflictBetween(a, b, `conflict.${i}`)),
      signalCounterparts: spec.counterparts
        ? {
            'sig.mfa-ca-events-in-logs': ['sig.error-name-not-resolved'],
            'sig.error-name-not-resolved': ['sig.mfa-ca-events-in-logs'],
          }
        : {},
      recommendations: spec.recommendations.map((r, i) => ({
        id: `fork:${i}`,
        actionId: r.action,
        label: LABELS[r.action],
        eventIds: r.eventIds,
      })),
    }),
  );

const proposalArb = (index: number): fc.Arbitrary<KeptProposal> =>
  fc.oneof(
    fc
      .record({ signalId: fc.constantFrom(...SIGNALS) })
      .map((p) => keptFixture('signal', { id: `p${index}`, ...p })),
    fc
      .tuple(eventId, eventId)
      .filter(([a, b]) => a !== b)
      .map(([a, b]) =>
        keptFixture('contradiction', {
          id: `p${index}`,
          sides: [
            { eventId: a, statement: 'One side states one thing.' },
            { eventId: b, statement: 'The other side states another.' },
          ],
        }),
      ),
    fc
      .record({
        requirementId: fc.constantFrom<string | null>(null, ...REQUIREMENTS),
        neededByEventId: eventId,
      })
      .map((p) => keptFixture('missing_evidence', { id: `p${index}`, ...p })),
    fc
      .record({
        actionId: fc.constantFrom<string | null>(null, ...ACTIONS),
        decisionEventId: eventId,
      })
      .map((p) => keptFixture('missed_step', { id: `p${index}`, availableEventIds: [], ...p })),
    fc.record({ decisionEventId: eventId, action: fc.constantFrom(...ACTIONS) }).map((p) =>
      keptFixture('counterfactual', {
        id: `p${index}`,
        decisionEventId: p.decisionEventId,
        alternativeAction: LABELS[p.action],
      }),
    ),
    fc.record({ action: fc.constantFrom(...ACTIONS), event: eventId }).map((p) =>
      keptFixture('recommendation', {
        id: `p${index}`,
        action: LABELS[p.action],
        evidence: [{ eventId: p.event, excerpt: QUOTES[p.event] }],
      }),
    ),
    fc.constant(0).map(() => keptFixture('case_synthesis', { id: `p${index}` })),
  );

const proposalsArb: fc.Arbitrary<KeptProposal[]> = fc
  .integer({ min: 0, max: 7 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => proposalArb(i))))
  .map((list) => list);

function criticFor(
  proposals: readonly KeptProposal[],
  picks: readonly { target: number; kind: CritiqueKind }[],
): CriticInput {
  const ctx = ruleContext();
  const refs: ConclusionRef[] = [
    { id: 'C1', source: 'engine', ref: 'hypothesis:hyp.conditional-access' },
    ...proposals.map((p, i): ConclusionRef => ({
      id: `C${i + 2}`,
      source: 'model',
      ref: p.proposal.id,
    })),
  ];
  const critiques = picks.map((pick) => {
    const quote = QUOTES.e2;
    const event = ctx.events.get('e2');
    const located = event ? locateCitation(event, { eventId: 'e2', excerpt: quote }) : null;
    if (!located) throw new Error('fixture');
    return {
      critique: {
        targetId: `C${(pick.target % (refs.length + 1)) + 1}`,
        kind: pick.kind,
        explanation: 'A concern about the statement.',
        evidence: [{ eventId: 'e2', excerpt: quote }],
        alternativeHypothesisId: null,
      },
      evidence: [located],
    };
  });
  const critic: KeptCritic = {
    result: PROPOSAL_SCHEMAS.critic_result.parse(criticResult()),
    evidence: [],
    critiques,
  };
  return { critic, conclusions: refs };
}

const picksArb = fc.array(
  fc.record({ target: fc.integer({ min: 0, max: 9 }), kind: fc.constantFrom(...CRITIQUE_KINDS) }),
  { maxLength: 5 },
);

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const run = (
  proposals: readonly KeptProposal[],
  facts: DeterministicFacts,
  critic: CriticInput | null = null,
) => combine({ proposals, critic, facts, provenance: PROVENANCE });

/** How much attention a status asks of a person; the critic can only raise it. */
const ATTENTION: Record<HybridStatus, number> = {
  MODEL_CORROBORATED: 0,
  MODEL_PROPOSED: 1,
  NEEDS_HUMAN_REVIEW: 2,
  CONFLICTING: 3,
  DETERMINISTIC: -1,
  REJECTED: -1,
};

const EMPTY_FACTS = plainFacts({
  signals: [],
  actions: [],
  forks: [],
  requirements: [],
  recommendations: [],
  counterfactuals: [],
  conflicts: null,
  signalCounterparts: {},
});

const RUNS = { numRuns: 120 };

describe('hybrid policy: properties', () => {
  it('does not depend on the order of the proposals', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, fc.nat(), (facts, proposals, seed) => {
        const rotated =
          proposals.length === 0
            ? []
            : [
                ...proposals.slice(seed % proposals.length),
                ...proposals.slice(0, seed % proposals.length),
              ];
        expect(run(rotated.reverse(), facts)).toEqual(run(proposals, facts));
      }),
      RUNS,
    );
  });

  it('gives the same result every time and changes neither the facts nor the proposals', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        const critic = criticFor(proposals, picks);
        const frozenFacts = deepFreeze(structuredClone(facts));
        const frozenProposals = deepFreeze(structuredClone(proposals));
        const frozenCritic = deepFreeze(structuredClone(critic));
        const first = run(frozenProposals, frozenFacts, frozenCritic);
        const second = run(frozenProposals, frozenFacts, frozenCritic);
        expect(second).toEqual(first);
        expect(frozenFacts).toEqual(facts);
        expect(frozenProposals).toEqual(proposals);
        expect(frozenCritic).toEqual(critic);
      }),
      RUNS,
    );
  });

  it('never makes a finding corroborated, or not needing review, from the model alone', () => {
    fc.assert(
      fc.property(proposalsArb, picksArb, (proposals, picks) => {
        for (const critic of [null, criticFor(proposals, picks)]) {
          for (const finding of run(proposals, EMPTY_FACTS, critic)) {
            expect(finding.hybridStatus).not.toBe('MODEL_CORROBORATED');
            expect(finding.deterministicCorroboration.state).not.toBe('corroborated');
            expect(finding.modelOnly).toBe(true);
            expect(finding.reviewRequired).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it('only ever yields a status a model finding can have, always pending and review-consistent', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        for (const finding of run(proposals, facts, criticFor(proposals, picks))) {
          expect([
            'MODEL_PROPOSED',
            'MODEL_CORROBORATED',
            'NEEDS_HUMAN_REVIEW',
            'CONFLICTING',
          ]).toContain(finding.hybridStatus);
          expect(finding.reviewState).toBe('pending');
          expect(finding.reviewRequired).toBe(finding.hybridStatus !== 'MODEL_CORROBORATED');
          expect(finding.modelOnly).toBe(
            finding.deterministicCorroboration.state !== 'corroborated',
          );
        }
      }),
      RUNS,
    );
  });

  it('lets the critic only escalate: no finding gets less attention, and none stops needing review', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        const without = run(proposals, facts);
        const withCritic = run(proposals, facts, criticFor(proposals, picks));
        expect(withCritic.map((f) => f.id)).toEqual(without.map((f) => f.id));
        withCritic.forEach((finding, i) => {
          const before = without[i] as AiFinding;
          expect(ATTENTION[finding.hybridStatus]).toBeGreaterThanOrEqual(
            ATTENTION[before.hybridStatus],
          );
          if (before.reviewRequired) expect(finding.reviewRequired).toBe(true);
          expect(finding.deterministicCorroboration).toEqual(before.deterministicCorroboration);
          expect(finding.evidence).toEqual(before.evidence);
          expect(finding.statement).toBe(before.statement);
          expect(finding.confidence).toBe(before.confidence);
        });
      }),
      RUNS,
    );
  });

  it('moves a finding by the critic only for an escalating critique of that finding', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        const critic = criticFor(proposals, picks);
        const without = run(proposals, facts);
        run(proposals, facts, critic).forEach((finding, i) => {
          const before = without[i] as AiFinding;
          if (finding.hybridStatus === before.hybridStatus) return;
          expect(finding.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
          expect(finding.criticNotes.some((n) => ESCALATING_CRITIQUE_KINDS.includes(n.kind))).toBe(
            true,
          );
        });
      }),
      RUNS,
    );
  });

  it('lets the engine’s own evidence win: a conflict is never lifted by any critique', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        const plain = run(proposals, facts);
        const critic = run(proposals, facts, criticFor(proposals, picks));
        critic.forEach((finding, i) => {
          if ((plain[i] as AiFinding).deterministicCorroboration.state === 'conflicts') {
            expect(finding.hybridStatus).toBe('CONFLICTING');
          }
        });
      }),
      RUNS,
    );
  });

  it('cites only items the engine has: every item it lists as corroborating or conflicting exists in the facts', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, (facts, proposals) => {
        const ids: Record<string, Set<string>> = {
          signal: new Set(facts.signals.map((s) => s.id)),
          action: new Set(facts.actions.map((a) => a.id)),
          fork: new Set(facts.forks.map((f) => f.id)),
          requirement: new Set(facts.requirements.map((r) => r.id)),
          recommendation: new Set(facts.recommendations.map((r) => r.id)),
          counterfactual: new Set(facts.counterfactuals.map((c) => c.id)),
          conflict: new Set((facts.conflicts ?? []).map((c) => c.id)),
        };
        for (const finding of run(proposals, facts)) {
          const { state, by } = finding.deterministicCorroboration;
          if (state === 'corroborated' || state === 'conflicts')
            expect(by.length).toBeGreaterThan(0);
          else expect(by).toEqual([]);
          for (const item of by) {
            expect(ids[item.kind]?.has(item.id)).toBe(true);
            for (const id of item.eventIds) expect(facts.eventOrder[id]).toBeDefined();
          }
        }
      }),
      RUNS,
    );
  });

  it('gives each distinct content one finding, with unique ids', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, (facts, proposals) => {
        const findings = run([...proposals, ...proposals], facts);
        expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
        expect(findings.length).toBe(run(proposals, facts).length);
      }),
      RUNS,
    );
  });

  it('never produces a status or a field only a person or the engine may set', () => {
    fc.assert(
      fc.property(factsArb, proposalsArb, picksArb, (facts, proposals, picks) => {
        for (const finding of run(proposals, facts, criticFor(proposals, picks))) {
          expect(finding.hybridStatus).not.toBe('DETERMINISTIC');
          expect(finding.hybridStatus).not.toBe('REJECTED');
          const keys = Object.keys(finding);
          for (const key of keys)
            expect(key).not.toMatch(/^(accepted|approved|approvedBy|acceptedAt|decision)$/i);
        }
      }),
      RUNS,
    );
  });
});
