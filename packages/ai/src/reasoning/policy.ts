import {
  ESCALATING_CRITIQUE_KINDS,
  FINDING_SCHEMA_VERSION,
  type AiFinding,
  type AiFindingCorroboration,
  type AiFindingCriticNote,
  type AiFindingEvidence,
  type AiFindingProvenance,
  type CorroborationState,
  type HybridStatus,
  type ReasonerProposal,
  type StatementModality,
} from '@caseguard/schemas';
import { sha256Hex } from '../util/hash';
import {
  isAtOrBefore,
  isBefore,
  mentions,
  unmetRequirementsAt,
  type DeterministicFacts,
} from './facts';
import { signatureOf } from './rules/duplicate';
import { collectEventRefs } from './text';
import type { KeptCritic, KeptProposal } from './types';

/**
 * The hybrid policy: how a model's proposal stands next to what the deterministic engine found on its own. Pure: the
 * result depends on the inputs only, the inputs are never changed, and nothing here approves, accepts or rejects.
 *
 * Rules, in this fixed order, for a proposal that passed the grounding rules (a proposal that did not is not a finding
 * and never reaches this function):
 *
 * 1. The engine's own evidence cuts against it: the signal is observed negated (or not as a fact), or its counterpart
 *    holds; the action it calls missed is recognised as done by the decision; the requirement it calls missing was met
 *    before the decision. -> `CONFLICTING`. Both sides are kept and shown; neither wins.
 * 2. A counterfactual or a recommendation the engine does not independently support, and every proposal the critic
 *    questions (unsupported claim, circular reasoning, premature closure, counterfactual overclaim, uncertainty hidden
 *    as fact, contradiction): -> `NEEDS_HUMAN_REVIEW`, the critique attached. The critic cannot lower an engine finding
 *    and cannot make a proposal look better.
 * 3. The engine independently supports it (same type, same subject, an overlapping event): -> `MODEL_CORROBORATED`.
 * 4. Otherwise -> `MODEL_PROPOSED`, model only.
 *
 * `DETERMINISTIC` is the status of the engine's own item, which a screen lists next to a model finding that agrees or
 * disagrees with it; a model finding is never `DETERMINISTIC`. `REJECTED` is what a reviewer's rejection gives; this
 * policy never produces it. Every finding leaves here `pending`.
 */

/** Which conclusion under review a critic id stands for. */
export interface ConclusionRef {
  id: string;
  source: 'engine' | 'model';
  /** The engine item id, or the model-local id of the proposal. */
  ref: string;
}

export interface CriticInput {
  critic: KeptCritic | null;
  conclusions: readonly ConclusionRef[];
}

export interface CombineInput {
  proposals: readonly KeptProposal[];
  critic: CriticInput | null;
  facts: DeterministicFacts;
  /** Where the proposals came from. */
  provenance: AiFindingProvenance;
}

/** A critique of one of the engine's own conclusions. It is shown next to the item and changes nothing about it. */
export interface EngineNote {
  conclusionId: string;
  /** The engine item the critique is about. */
  ref: string;
  note: AiFindingCriticNote;
}

const NOT_AS_FACT: ReadonlySet<StatementModality> = new Set<StatementModality>([
  'negated',
  'speculative',
  'future_intent',
  'conditional',
  'requested',
]);

/** The order findings are listed in: by type, then by key. */
export const TYPE_ORDER: Record<ReasonerProposal['type'], number> = {
  signal: 0,
  contradiction: 1,
  missing_evidence: 2,
  missed_step: 3,
  counterfactual: 4,
  recommendation: 5,
  case_synthesis: 6,
};

interface Stance {
  state: CorroborationState;
  by: AiFindingCorroboration['by'];
}

const NOT_FOUND: Stance = { state: 'not_found', by: [] };
const NOT_APPLICABLE: Stance = { state: 'not_applicable', by: [] };

const by = (
  kind: string,
  id: string,
  eventIds: readonly string[],
): AiFindingCorroboration['by'][number] => ({
  kind,
  id,
  eventIds: [...new Set(eventIds)].sort().slice(0, 20),
});

const tidy = (list: AiFindingCorroboration['by']): AiFindingCorroboration['by'] => {
  const seen = new Set<string>();
  return list
    .filter((item) => {
      const key = `${item.kind}|${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, 20);
};

const evidenceEventIds = (kept: KeptProposal): Set<string> =>
  new Set(collectEventRefs(kept.proposal).map((ref) => ref.eventId));

function signalStance(
  p: Extract<ReasonerProposal, { type: 'signal' }>,
  events: ReadonlySet<string>,
  facts: DeterministicFacts,
): Stance {
  const holds = (m: StatementModality | null): boolean => m === null || m === 'asserted';
  const same = facts.signals.filter((s) => s.signalId === p.signalId && events.has(s.eventId));
  const counterparts = new Set(facts.signalCounterparts[p.signalId] ?? []);
  const against = [
    ...same.filter((s) => s.modality !== null && NOT_AS_FACT.has(s.modality)),
    ...facts.signals.filter(
      (s) => counterparts.has(s.signalId) && events.has(s.eventId) && holds(s.modality),
    ),
  ];
  if (against.length > 0) {
    return {
      state: 'conflicts',
      by: tidy(against.map((s) => by('signal', s.id, [s.eventId]))),
    };
  }
  const support = same.filter((s) => holds(s.modality));
  return support.length > 0
    ? { state: 'corroborated', by: tidy(support.map((s) => by('signal', s.id, [s.eventId]))) }
    : NOT_FOUND;
}

function contradictionStance(
  p: Extract<ReasonerProposal, { type: 'contradiction' }>,
  facts: DeterministicFacts,
): Stance {
  if (facts.conflicts === null) return NOT_APPLICABLE;
  const pair = new Set(p.sides.map((s) => s.eventId));
  const match = facts.conflicts.filter((c) => {
    const [first, second] = c.sides;
    return pair.has(first.eventId) && pair.has(second.eventId) && first.eventId !== second.eventId;
  });
  return match.length > 0
    ? {
        state: 'corroborated',
        by: tidy(
          match.map((c) =>
            by(
              'conflict',
              c.id,
              c.sides.map((s) => s.eventId),
            ),
          ),
        ),
      }
    : NOT_FOUND;
}

function missingEvidenceStance(
  p: Extract<ReasonerProposal, { type: 'missing_evidence' }>,
  facts: DeterministicFacts,
): Stance {
  if (p.requirementId === null) return NOT_FOUND;
  const of = facts.requirements.filter((r) => r.requirementId === p.requirementId);
  const met = of.filter(
    (r) => r.resolvedByEventId !== null && isBefore(facts, r.resolvedByEventId, p.neededByEventId),
  );
  if (met.length > 0) {
    return {
      state: 'conflicts',
      by: tidy(met.map((r) => by('requirement', r.id, [r.resolvedByEventId ?? p.neededByEventId]))),
    };
  }
  const unmet = unmetRequirementsAt(facts, p.neededByEventId).filter(
    (r) => r.requirementId === p.requirementId,
  );
  return unmet.length > 0
    ? {
        state: 'corroborated',
        by: tidy(unmet.map((r) => by('requirement', r.id, [p.neededByEventId]))),
      }
    : NOT_FOUND;
}

function missedStepStance(
  p: Extract<ReasonerProposal, { type: 'missed_step' }>,
  facts: DeterministicFacts,
): Stance {
  const decision = p.decisionEventId;
  if (p.actionId !== null) {
    const done = facts.actions.filter(
      (a) => a.actionId === p.actionId && isAtOrBefore(facts, a.eventId, decision),
    );
    if (done.length > 0) {
      return { state: 'conflicts', by: tidy(done.map((a) => by('action', a.id, [a.eventId]))) };
    }
  }
  const forks = facts.forks.filter(
    (f) =>
      f.eventId === decision &&
      (p.actionId === null || f.alternativeActionIds.includes(p.actionId)),
  );
  return forks.length > 0
    ? { state: 'corroborated', by: tidy(forks.map((f) => by('fork', f.id, [f.eventId]))) }
    : NOT_FOUND;
}

function counterfactualStance(
  p: Extract<ReasonerProposal, { type: 'counterfactual' }>,
  facts: DeterministicFacts,
): Stance {
  const text = p.alternativeAction;
  const forks = facts.forks.filter(
    (f) =>
      f.eventId === p.decisionEventId &&
      f.alternativeActionIds.some((id, i) => mentions(text, f.alternativeLabels[i] ?? id, id)),
  );
  const claims = facts.counterfactuals.filter(
    (c) =>
      c.forkEventId === p.decisionEventId &&
      (mentions(text, c.label) || c.alternativeActionIds.some((id) => mentions(text, id, id))),
  );
  const found = [
    ...forks.map((f) => by('fork', f.id, [f.eventId])),
    ...claims.map((c) => by('counterfactual', c.id, [c.forkEventId])),
  ];
  return found.length > 0 ? { state: 'corroborated', by: tidy(found) } : NOT_FOUND;
}

function recommendationStance(
  p: Extract<ReasonerProposal, { type: 'recommendation' }>,
  events: ReadonlySet<string>,
  facts: DeterministicFacts,
): Stance {
  const match = facts.recommendations.filter(
    (r) =>
      mentions(p.action, r.label, r.actionId) &&
      (r.eventIds.length === 0 || r.eventIds.some((id) => events.has(id))),
  );
  return match.length > 0
    ? { state: 'corroborated', by: tidy(match.map((r) => by('recommendation', r.id, r.eventIds))) }
    : NOT_FOUND;
}

/** What the engine independently found about this proposal. Reads the facts and nothing else. */
export function stanceOf(kept: KeptProposal, facts: DeterministicFacts): Stance {
  const p = kept.proposal;
  const events = evidenceEventIds(kept);
  switch (p.type) {
    case 'signal':
      return signalStance(p, events, facts);
    case 'contradiction':
      return contradictionStance(p, facts);
    case 'missing_evidence':
      return missingEvidenceStance(p, facts);
    case 'missed_step':
      return missedStepStance(p, facts);
    case 'counterfactual':
      return counterfactualStance(p, facts);
    case 'recommendation':
      return recommendationStance(p, events, facts);
    case 'case_synthesis':
      return NOT_APPLICABLE;
  }
}

/** The finding key: the same content always gets the same one, whatever the model called it and wherever it stood. */
export function findingKey(kept: KeptProposal): string {
  const { id: _localId, ...content } = kept.proposal;
  const located = [...kept.evidence, ...kept.keyPointEvidence.flat()].map((e) => [
    e.eventId,
    e.verifiedIn,
    e.field,
    e.start,
    e.end,
    e.excerpt,
  ]);
  return `fnd_${sha256Hex(JSON.stringify([signatureOf(kept.proposal), content, located])).slice(0, 24)}`;
}

const noteOf = (critique: KeptCritic['critiques'][number]): AiFindingCriticNote => ({
  kind: critique.critique.kind,
  explanation: critique.critique.explanation,
  evidence: critique.evidence,
  alternativeHypothesisId:
    critique.critique.kind === 'alternative_explanation'
      ? critique.critique.alternativeHypothesisId
      : null,
});

const sortedNotes = (notes: readonly AiFindingCriticNote[]): AiFindingCriticNote[] => {
  const unique = new Map<string, AiFindingCriticNote>();
  for (const note of notes) unique.set(JSON.stringify(note), note);
  return [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, note]) => note)
    .slice(0, 12);
};

const questions = (notes: readonly AiFindingCriticNote[]): boolean =>
  notes.some((n) => ESCALATING_CRITIQUE_KINDS.includes(n.kind));

/** Critiques of the engine's own conclusions, by the engine item they are about. They change nothing about the item. */
export function critiquesOfEngine(input: CriticInput | null): EngineNote[] {
  if (!input?.critic) return [];
  const notes: EngineNote[] = [];
  for (const critique of input.critic.critiques) {
    const conclusion = input.conclusions.find(
      (c) => c.id === critique.critique.targetId && c.source === 'engine',
    );
    if (conclusion) {
      notes.push({ conclusionId: conclusion.id, ref: conclusion.ref, note: noteOf(critique) });
    }
  }
  return notes.sort((a, b) =>
    a.ref !== b.ref
      ? a.ref.localeCompare(b.ref)
      : JSON.stringify(a.note).localeCompare(JSON.stringify(b.note)),
  );
}

function statusOf(
  type: ReasonerProposal['type'],
  state: CorroborationState,
  notes: readonly AiFindingCriticNote[],
): HybridStatus {
  if (state === 'conflicts') return 'CONFLICTING';
  const needsSupport = type === 'counterfactual' || type === 'recommendation';
  if ((needsSupport && state !== 'corroborated') || questions(notes)) return 'NEEDS_HUMAN_REVIEW';
  return state === 'corroborated' ? 'MODEL_CORROBORATED' : 'MODEL_PROPOSED';
}

function payloadOf(kept: KeptProposal): Record<string, unknown> {
  const {
    id: _id,
    type: _type,
    statement: _statement,
    evidence: _evidence,
    reasoning: _reasoning,
    confidenceBasis: _basis,
    confidence: _confidence,
    uncertainty: _uncertainty,
    contradictions: _contradictions,
    ...payload
  } = kept.proposal;
  if (kept.proposal.type === 'case_synthesis') {
    const withEvidence: { point: string; evidence: AiFindingEvidence[] }[] =
      kept.proposal.keyPoints.map((point, i) => ({
        point: point.point,
        evidence: kept.keyPointEvidence[i] ?? [],
      }));
    return { ...payload, keyPoints: withEvidence };
  }
  return payload;
}

/**
 * Combines the proposals that passed the grounding rules with the critic's critiques and the engine's facts. The
 * result is one finding per distinct proposal, in a fixed order, whatever order the inputs came in; running it again
 * on the same input gives the same result; the facts are only read.
 */
export function combine(input: CombineInput): AiFinding[] {
  const { facts, provenance } = input;
  const mapping = input.critic?.conclusions ?? [];
  const critiques = input.critic?.critic?.critiques ?? [];

  const groups = new Map<
    string,
    { kept: KeptProposal; localIds: Set<string>; notes: AiFindingCriticNote[] }
  >();
  for (const kept of [...input.proposals].sort((a, b) =>
    a.proposal.id < b.proposal.id ? -1 : a.proposal.id > b.proposal.id ? 1 : 0,
  )) {
    const key = findingKey(kept);
    const group = groups.get(key) ?? { kept, localIds: new Set<string>(), notes: [] };
    group.localIds.add(kept.proposal.id);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    for (const critique of critiques) {
      const conclusion = mapping.find((c) => c.id === critique.critique.targetId);
      if (conclusion?.source === 'model' && group.localIds.has(conclusion.ref)) {
        group.notes.push(noteOf(critique));
      }
    }
  }

  return [...groups.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        TYPE_ORDER[a.kept.proposal.type] - TYPE_ORDER[b.kept.proposal.type] ||
        (ka < kb ? -1 : ka > kb ? 1 : 0),
    )
    .map(([key, group]) => {
      const { kept } = group;
      const stance = stanceOf(kept, facts);
      const notes = sortedNotes(group.notes);
      const hybridStatus = statusOf(kept.proposal.type, stance.state, notes);
      const p = kept.proposal;
      return {
        schemaVersion: FINDING_SCHEMA_VERSION,
        id: key,
        type: p.type,
        statement: p.statement,
        evidence: kept.evidence,
        reasoning: p.reasoning,
        confidenceBasis: p.confidenceBasis,
        confidence: p.confidence,
        uncertainty: p.uncertainty,
        contradictions: p.contradictions,
        deterministicCorroboration: { state: stance.state, by: stance.by },
        modelOnly: stance.state !== 'corroborated',
        validationStatus: kept.notes.length > 0 ? 'passed_with_notes' : 'passed',
        hybridStatus,
        reviewRequired: hybridStatus !== 'MODEL_CORROBORATED',
        reviewState: 'pending',
        checks: kept.checks,
        criticNotes: notes,
        provenance,
        payload: payloadOf(kept),
      } as AiFinding;
    });
}
