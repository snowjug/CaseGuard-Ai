import {
  ENGINEER_SIDE_ROLES,
  type ActionValueConfig,
  type Claim,
  type DiagnosticAction,
  type Evidence,
  type Hypothesis,
  type HypothesisActionRef,
  type HypothesisEvidenceLink,
  type HypothesisPoint,
  type HypothesisStatus,
  type MissingEvidence,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { hypothesisRecordId, stableId } from '../util/ids';
import { round } from '../util/math';
import { rankActions } from './action-value';
import { type BeliefTimeline, hypothesisStatus, likelihoodOf } from './belief';
import { evidenceEffectFor } from './claims';
import { type EngineContext, metaOf } from './context';
import { riskLevelOf } from './forks';
import { satisfiedSetAt, type RequirementState } from './requirements';
import type { Observation } from './signals';

export interface HypothesesInput {
  pack: CompiledPack;
  ctx: EngineContext;
  config: ActionValueConfig;
  timeline: BeliefTimeline;
  observations: readonly Observation[];
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  actions: readonly DiagnosticAction[];
  requirementStates: readonly RequirementState[];
}

export interface HypothesesOutput {
  hypotheses: Hypothesis[];
  links: HypothesisEvidenceLink[];
  missing: MissingEvidence[];
}

export const HYPOTHESIS_NOTICE =
  'Confidence values are model estimates computed from the knowledge pack and the evidence on record. They are not statistical probabilities and they change as evidence arrives.';

const LINK_THRESHOLD_BITS = 0.3;
const pct = (p: number): string => `${Math.round(p * 100)}%`;

export function buildHypotheses(input: HypothesesInput): HypothesesOutput {
  const {
    pack,
    ctx,
    config,
    timeline,
    observations,
    evidence,
    claims,
    actions,
    requirementStates,
  } = input;
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));

  // Ranking after every event, computed once and shared by all hypotheses.
  const rankingAfter = timeline.steps.map((step, i) => {
    const observed = new Set(observations.filter((o) => o.eventIndex <= i).map((o) => o.signalId));
    return rankActions(pack, config, {
      belief: step.posterior,
      observedSignals: observed,
      satisfied: satisfiedSetAt(requirementStates, i),
    }).candidates;
  });

  const hypotheses: Hypothesis[] = [];
  const links: HypothesisEvidenceLink[] = [];

  for (const h of pack.pack.hypotheses) {
    const id = hypothesisRecordId(ctx.caseId, h.id);
    const points: HypothesisPoint[] = [];
    let previousStatus: HypothesisStatus | null = null;
    let peak = h.prior;
    let previousP = h.prior;
    let lastAction: HypothesisActionRef | null = null;

    const actionRefFor = (stepIndex: number): HypothesisActionRef | null => {
      const candidates = rankingAfter[stepIndex] ?? [];
      const relevant = candidates.filter(
        (c) =>
          (c.action.targets.includes(h.id) || h.validatingActionIds.includes(c.action.id)) &&
          c.eigBits >= 0.02,
      );
      const pick = [...relevant].sort(
        (a, b) => a.denominator - b.denominator || b.eigBits - a.eigBits,
      )[0];
      if (!pick) return null;
      return {
        actionKey: pick.action.id,
        label: pick.action.label,
        rationale:
          `${pick.action.description} Expected information ${round(pick.eigBits, 2)} bits at ${pick.action.customerEffort.replace('_', ' ')} customer effort.`.slice(
            0,
            480,
          ),
        expectedInformationGainBits: round(pick.eigBits, 3),
        actionValue: round(pick.score, 4),
        risk: riskLevelOf(pick.action.operationalRisk),
        customerEffort: pick.action.customerEffort,
        tokenEstimate: pick.action.tokenEstimate,
        timeMinutes: pick.action.timeMinutes.typical,
      };
    };

    timeline.steps.forEach((step, i) => {
      const p = step.posterior[h.id] ?? 0;
      peak = Math.max(peak, p);
      const satisfied = satisfiedSetAt(requirementStates, i);
      const status = hypothesisStatus(pack, step.posterior, h.id, {
        peak: { [h.id]: peak },
        confirmationMet: (hid) =>
          (pack.hypotheses.get(hid)?.confirmationRequirementIds ?? []).every((r) =>
            satisfied.has(r),
          ),
      });
      const triggers = step.effects
        .filter((eff) => Math.abs(eff.logLr[h.id] ?? 0) >= LINK_THRESHOLD_BITS)
        .map((eff) => ({ id: eff.observation.id, logLr: eff.logLr[h.id] ?? 0 }));
      const delta = p - previousP;
      const include =
        i === 0 ||
        i === timeline.steps.length - 1 ||
        Math.abs(delta) >= 0.01 ||
        status !== previousStatus ||
        triggers.length > 0;
      if (include) {
        const effect = evidenceEffectFor(timeline, i + 1, h.id);
        const label = (obsId: string): string => evidenceById.get(obsId)?.label ?? 'evidence';
        const rising = triggers.filter((t) => t.logLr > 0).map((t) => `“${label(t.id)}”`);
        const falling = triggers.filter((t) => t.logLr < 0).map((t) => `“${label(t.id)}”`);
        let reason: string;
        const moved = Math.abs(delta) >= 0.01;
        const statusChanged = status !== previousStatus && previousStatus !== null;
        const movement = moved
          ? `${delta > 0 ? 'Rose' : 'Fell'} from ${pct(previousP)} to ${pct(p)}`
          : null;
        const statusNote = statusChanged
          ? `status changed from ${(previousStatus ?? '').replace('_', ' ')} to ${status.replace('_', ' ')}`
          : null;
        const drivers = delta >= 0 ? rising : falling;
        if (i === 0 && triggers.length === 0) {
          reason = `Starting estimate from the knowledge-pack prior (${pct(h.prior)}).`;
        } else if (movement || statusNote) {
          const head =
            movement && statusNote
              ? `${movement}; ${statusNote}`
              : (movement ??
                `Status changed from ${(previousStatus ?? '').replace('_', ' ')} to ${status.replace('_', ' ')} (${pct(p)})`);
          const because =
            drivers.length > 0
              ? ` ${delta >= 0 ? 'Supported by' : 'Weakened by'} ${drivers.slice(0, 3).join(', ')}.`
              : moved
                ? ` ${delta >= 0 ? 'Competing explanations weakened.' : 'Competing explanations gained support.'}`
                : '';
          reason = `${head}.${because}`;
        } else {
          reason = `No material change (${pct(p)}).`;
        }
        const missingIds = h.confirmationRequirementIds.filter((r) => !satisfied.has(r));
        lastAction = actionRefFor(i);
        points.push({
          at: step.at,
          eventId: step.eventId,
          confidence: round(p, 3),
          low: round(step.low[h.id] ?? p, 3),
          high: round(step.high[h.id] ?? p, 3),
          status,
          delta: round(delta, 3),
          reason: reason.slice(0, 600),
          triggerEvidenceIds: triggers.map((t) => t.id),
          supportingEvidenceIds: effect.supporting.slice(0, 3).map((s) => s.id),
          contradictingEvidenceIds: effect.contradicting.slice(0, 3).map((s) => s.id),
          missingRequirementIds: missingIds,
          cheapestSafeActionKey: lastAction?.actionKey ?? null,
          expectedInformationGainBits: lastAction?.expectedInformationGainBits ?? null,
        });
      }
      previousStatus = status;
      previousP = p;
    });

    const last = points[points.length - 1];
    const anchoredClaim = claims
      .filter(
        (c) =>
          c.authorRole !== null &&
          ENGINEER_SIDE_ROLES.includes(c.authorRole) &&
          c.relatedHypothesisIds.includes(h.id) &&
          (c.category === 'engineer_assumption' || c.category === 'confirmed_fact'),
      )
      .map((c) => c.timestamp);
    const anchoredAction = actions
      .filter((a) => a.statedHypothesisId === id)
      .map((a) => a.startedAt);
    const anchored = [...anchoredClaim, ...anchoredAction].sort()[0] ?? null;

    hypotheses.push({
      ...metaOf(ctx),
      id,
      caseId: ctx.caseId,
      analysisRunId: ctx.runId,
      key: h.id,
      name: h.name,
      description: h.description,
      category: h.category,
      prior: h.prior,
      timeline: points,
      currentConfidence: last?.confidence ?? h.prior,
      currentLow: last?.low ?? h.prior,
      currentHigh: last?.high ?? h.prior,
      currentStatus: last?.status ?? 'active',
      assumptions: h.assumptions,
      engineerAnchoredAt: anchored,
      cheapestSafeAction: lastAction,
      modelEstimate: true,
    });
  }

  // Evidence <-> hypothesis links ------------------------------------------------------------
  for (const step of timeline.steps) {
    for (const eff of step.effects) {
      const signal = pack.signals.get(eff.observation.signalId);
      if (!signal) continue;
      for (const h of pack.pack.hypotheses) {
        const logLr = eff.logLr[h.id] ?? 0;
        if (Math.abs(logLr) < LINK_THRESHOLD_BITS) continue;
        const own = likelihoodOf(pack, signal.id, h.id);
        const others = pack.hypothesisIds
          .filter((o) => o !== h.id)
          .map((o) => likelihoodOf(pack, signal.id, o));
        const otherMean = others.reduce((s, x) => s + x, 0) / Math.max(1, others.length);
        links.push({
          ...metaOf(ctx),
          id: stableId('hel', ctx.caseId, h.id, eff.observation.id),
          caseId: ctx.caseId,
          analysisRunId: ctx.runId,
          hypothesisId: hypothesisRecordId(ctx.caseId, h.id),
          evidenceId: eff.observation.id,
          polarity: logLr > 0 ? 'supports' : 'contradicts',
          likelihood: round(own, 3),
          logLikelihoodRatio: round(logLr, 3),
          effectOnConfidence: round(eff.delta[h.id] ?? 0, 3),
          rationale:
            `Under “${h.name}” this signal is expected about ${pct(own)} of the time versus about ${pct(otherMean)} across the other explanations. ${signal.explanation}`.slice(
              0,
              600,
            ),
          observedAt: eff.observation.timestamp,
        });
      }
    }
  }

  // Missing evidence --------------------------------------------------------------------------
  const missing: MissingEvidence[] = [];
  for (const state of requirementStates) {
    if (state.firstRelevantAt === null) continue;
    const req = pack.requirements.get(state.requirementId);
    if (!req) continue;
    const neededFor = pack.pack.hypotheses
      .filter((h) => h.confirmationRequirementIds.includes(req.id))
      .map((h) => h.name);
    if (pack.pack.policies.minimumEvidenceForEscalation.includes(req.id))
      neededFor.push('Escalation');
    if (req.neededFrom === 'before_closure') neededFor.push('Closure');
    missing.push({
      id: stableId('mis', ctx.caseId, req.id),
      requirementId: req.id,
      label: req.label,
      description: req.description,
      criticality: req.criticality,
      category: req.category,
      firstRelevantAt: state.firstRelevantAt,
      resolvedAt: state.satisfiedAt,
      resolvedByEventId: state.satisfiedByEventId,
      neededFor,
      askText: req.askText,
    });
  }
  return { hypotheses, links, missing };
}
