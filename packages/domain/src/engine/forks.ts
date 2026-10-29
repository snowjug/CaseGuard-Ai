import {
  DEFAULT_EFFORT_MINUTES,
  type ActionValueBreakdown,
  type ActionValueConfig,
  type Claim,
  type ConsequenceEstimate,
  type DecisionFork,
  type DiagnosticAction,
  type Evidence,
  type ForkAlternative,
  type ForkCategory,
  type Level,
  type RiskLevel,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { hypothesisRecordId, stableId } from '../util/ids';
import { clamp, round } from '../util/math';
import { formatUtcStamp } from '../util/time';
import {
  type DecisionRanking,
  actionCostOf,
  isHygieneAction,
  MIN_MEANINGFUL_COST,
  rankAtIndex,
  resolveActionKey,
  responderClosure,
} from './actions';
import { type Belief, type BeliefTimeline, topHypotheses } from './belief';
import { type AnchorInfo, evidenceEffectFor, leaderOf } from './claims';
import { type EngineContext, metaOf } from './context';
import { missingRequirementsAt, type RequirementState } from './requirements';
import type { Observation } from './signals';
import { PrefixAnalyzer } from './state';
import type { TemporalView } from './temporal';

/** Impact at or above which a fork counts as "meaningful" for the earliest-meaningful marker. */
export const EARLIEST_MEANINGFUL_IMPACT = 0.45;
const HIGH_EFFORT_SCORE = 0.8;
const MAX_ALTERNATIVES = 4;

const SEVERITY_BASE: Record<ForkCategory, number> = {
  premature_destructive_action: 0.9,
  premature_escalation: 0.7,
  assumption_as_fact: 0.7,
  contradiction_ignored: 0.75,
  high_value_signal_unused: 0.6,
  disproportionate_customer_effort: 0.55,
  low_value_action: 0.45,
  alternative_action_available: 0.3,
};

/** Value share assumed for decisions that are not ranked diagnostics (escalations, statements). */
const RELATIVE_PROXY: Record<ForkCategory, number> = {
  premature_destructive_action: 0.05,
  premature_escalation: 0.15,
  assumption_as_fact: 0.3,
  contradiction_ignored: 0.25,
  high_value_signal_unused: 0.4,
  disproportionate_customer_effort: 0.4,
  low_value_action: 0.3,
  alternative_action_available: 0.5,
};

const RULE_IDS: Record<ForkCategory, string> = {
  premature_destructive_action: 'FORK-R1-premature-destructive',
  premature_escalation: 'FORK-R2-premature-escalation',
  assumption_as_fact: 'FORK-R3-assumption-as-fact',
  contradiction_ignored: 'FORK-R4-contradiction-ignored',
  high_value_signal_unused: 'FORK-R5-signal-unused',
  disproportionate_customer_effort: 'FORK-R6-disproportionate-effort',
  low_value_action: 'FORK-R7-low-value',
  alternative_action_available: 'FORK-R8-better-alternative',
};

/** Category priority: when several rules fire on one event the earliest listed becomes primary. */
const PRIORITY: readonly ForkCategory[] = [
  'premature_destructive_action',
  'premature_escalation',
  'assumption_as_fact',
  'contradiction_ignored',
  'high_value_signal_unused',
  'disproportionate_customer_effort',
  'low_value_action',
  'alternative_action_available',
];

export interface ForksInput {
  view: TemporalView;
  pack: CompiledPack;
  ctx: EngineContext;
  config: ActionValueConfig;
  timeline: BeliefTimeline;
  observations: readonly Observation[];
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  anchors: readonly AnchorInfo[];
  requirementStates: readonly RequirementState[];
  actions: readonly DiagnosticAction[];
  decisions: ReadonlyMap<string, DecisionRanking>;
  /** Shared prefix analyzer; created on demand when omitted. */
  analyzer?: PrefixAnalyzer;
}

export interface ForksOutput {
  forks: DecisionFork[];
  earliestMeaningfulForkId: string | null;
}

interface RuleHit {
  category: ForkCategory;
  detail: string;
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const levelOf = (score: number, hi: number, mid: number): Level =>
  score >= hi ? 'high' : score >= mid ? 'medium' : 'low';
export const riskLevelOf = (risk: number): RiskLevel =>
  risk >= 0.6 ? 'high' : risk >= 0.3 ? 'medium' : 'low';

function hasFlag(claim: Claim, ...flags: Claim['flags']): boolean {
  return flags.some((f) => claim.flags.includes(f));
}

function effortMinutes(action: { customerEffort: DiagnosticAction['customerEffort'] }): number {
  return DEFAULT_EFFORT_MINUTES[action.customerEffort];
}

function consequenceFor(
  key: string | null,
  actual: DiagnosticAction | undefined,
  pack: CompiledPack,
  config: ActionValueConfig,
): ConsequenceEstimate {
  const packAction = key ? pack.actions.get(key) : undefined;
  if (packAction) {
    return {
      timeToUsefulEvidenceMinutes: {
        low: packAction.timeMinutes.min,
        mid: packAction.timeMinutes.typical,
        high: packAction.timeMinutes.max,
      },
      customerEffortScore: config.effortScale[packAction.customerEffort],
      tokenEstimate: packAction.tokenEstimate,
      riskLevel: riskLevelOf(
        packAction.destructive
          ? Math.max(packAction.operationalRisk, 0.6)
          : packAction.operationalRisk,
      ),
      estimated: true,
    };
  }
  const minutes = actual?.durationMinutes ?? 15;
  return {
    timeToUsefulEvidenceMinutes: { low: minutes * 0.5, mid: minutes, high: minutes * 2 },
    customerEffortScore: actual?.customerEffortScore ?? 0,
    tokenEstimate: actual?.tokenEstimate ?? 0,
    riskLevel: riskLevelOf(actual?.operationalRisk ?? 0),
    estimated: true,
  };
}

function alternativeFrom(
  breakdown: ActionValueBreakdown,
  pack: CompiledPack,
  belief: Belief,
  supporting: string[],
): ForkAlternative {
  const packAction = pack.actions.get(breakdown.actionKey);
  const targets = packAction?.targets ?? [];
  const targetText = targets
    .map((t) => `“${pack.hypotheses.get(t)?.name ?? t}” (${pct(belief[t] ?? 0)})`)
    .slice(0, 2)
    .join(' and ');
  const unlocks = /Valued mainly for what it unlocks: “([^”]+)”/.exec(breakdown.explanation)?.[1];
  const rationale = [
    packAction?.description ?? breakdown.label,
    targetText ? `Tests ${targetText}.` : null,
    unlocks ? `Mainly valuable because it unlocks “${unlocks}”.` : null,
    `Estimated ${round(breakdown.inputs.expectedInformationGainBits, 2)} bits of information for about ${packAction?.timeMinutes.typical ?? breakdown.inputs.timeMinutes} minutes.`,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
  return {
    actionKey: breakdown.actionKey,
    label: breakdown.label,
    kind: breakdown.kind,
    rationale,
    supportingEvidenceIds: supporting,
    expectedInformationGainBits: breakdown.inputs.expectedInformationGainBits,
    relevance: breakdown.inputs.relevance,
    actionValue: Math.max(0, breakdown.score),
    relativeValue: breakdown.relativeScore,
    timeMinutes: breakdown.inputs.timeMinutes,
    customerEffort: packAction?.customerEffort ?? 'none',
    operationalRisk: breakdown.inputs.operationalRisk,
    tokenEstimate: breakdown.inputs.tokens,
    safe: breakdown.safety.allowed,
    blockedReasons: breakdown.safety.blockedReasons,
    requiresFirst: breakdown.requiresFirst,
  };
}

export function detectForks(input: ForksInput): ForksOutput {
  const { view, pack, ctx, config, timeline, claims, anchors, actions, decisions } = input;
  const events = view.events;
  const analyzer = input.analyzer ?? new PrefixAnalyzer(view, pack, ctx.caseId);
  const policies = pack.pack.policies;
  const hypName = (id: string): string => pack.hypotheses.get(id)?.name ?? id;
  const actionByEvent = new Map(actions.map((a) => [a.eventId, a]));
  const evidenceByEvent = new Map<string, Evidence[]>();
  for (const ev of input.evidence)
    evidenceByEvent.set(ev.eventId, [...(evidenceByEvent.get(ev.eventId) ?? []), ev]);
  const observationEvidence = new Map(input.evidence.map((e) => [e.id, e]));

  // Decision points: every action, plus engineer statements flagged by the evidence ledger.
  const flaggedByEvent = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (!claim.eventId || claim.simulated) continue;
    if (!hasFlag(claim, 'assumption_as_fact', 'unsupported_root_cause', 'ignored_contradiction'))
      continue;
    flaggedByEvent.set(claim.eventId, [...(flaggedByEvent.get(claim.eventId) ?? []), claim]);
  }
  const anchorByEvent = new Map(anchors.map((a) => [a.eventId, a]));

  const forks: DecisionFork[] = [];
  events.forEach((event, eventIndex) => {
    const action = actionByEvent.get(event.id);
    const flagged = flaggedByEvent.get(event.id) ?? [];
    const anchor = anchorByEvent.get(event.id);
    if (!action && flagged.length === 0 && !anchor) return;

    const actionKey = action?.actionKey ?? resolveActionKey(event, pack);
    const packAction = actionKey ? pack.actions.get(actionKey) : undefined;
    const decision =
      decisions.get(event.id) ?? rankAtIndex(analyzer, event, eventIndex, pack, config, actionKey);
    const analysis = decision.analysis;
    const belief = analysis.belief;
    const leader = leaderOf(belief);
    const leaderName = hypName(leader.id);
    const satisfied = analysis.rankingState.satisfied;
    const missingNow = missingRequirementsAt(
      analysis.requirementStates,
      Math.max(0, eventIndex - 1),
    ).map((s) => pack.requirements.get(s.requirementId)?.label ?? s.requirementId);

    // ---- rule evaluation (uses only information strictly before the event) ------------------
    const hits: RuleHit[] = [];
    const targetMass = packAction
      ? Math.max(0, ...packAction.targets.map((t) => belief[t] ?? 0))
      : leader.p;
    const targetsConfirmed = packAction
      ? packAction.targets.every((t) =>
          (pack.hypotheses.get(t)?.confirmationRequirementIds ?? []).every((r) => satisfied.has(r)),
        )
      : false;
    const risky =
      action !== undefined &&
      (action.destructive ||
        action.operationalRisk >= config.riskCeiling ||
        packAction?.valueClass === 'remediation');
    if (risky && (targetMass < policies.destructiveHypothesisThreshold || !targetsConfirmed)) {
      hits.push({
        category: 'premature_destructive_action',
        detail: `Targeted hypothesis at ${pct(targetMass)} (needs ${pct(policies.destructiveHypothesisThreshold)} with confirming evidence).`,
      });
    }

    const missingEscalation = policies.minimumEvidenceForEscalation.filter(
      (r) => !satisfied.has(r),
    );
    if (
      (packAction?.kind === 'escalation' || event.type === 'escalation') &&
      missingEscalation.length > 0
    ) {
      hits.push({
        category: 'premature_escalation',
        detail: `Missing before escalation: ${missingEscalation.map((r) => pack.requirements.get(r)?.label ?? r).join('; ')}.`,
      });
    }

    const assumption = flagged.find((c) =>
      hasFlag(c, 'assumption_as_fact', 'unsupported_root_cause'),
    );
    if (assumption) hits.push({ category: 'assumption_as_fact', detail: assumption.text });

    const contradicted = flagged.find(
      (c) => hasFlag(c, 'ignored_contradiction') && c.category !== 'conflicting_evidence',
    );
    if (anchor || contradicted) {
      hits.push({
        category: 'contradiction_ignored',
        detail: anchor
          ? `Working hypothesis “${hypName(anchor.hypothesisId)}” stood at ${pct(anchor.pBefore)} while “${hypName(anchor.leaderId)}” stood at ${pct(anchor.leaderP)}.`
          : (contradicted?.text ?? ''),
      });
    }

    // Strong signal already on record that the chosen action does not test.
    const strongSupport = evidenceEffectFor(timeline, eventIndex, leader.id).supporting.filter(
      (s) => s.logLr >= 1,
    );
    const testsLeader = packAction ? packAction.targets.includes(leader.id) : false;
    const signalEventIndex = Math.min(
      eventIndex,
      ...strongSupport
        .map((s) => events.findIndex((e) => e.id === observationEvidence.get(s.id)?.eventId))
        .filter((i) => i >= 0),
    );
    const actedOnLeader = actions.some(
      (a) =>
        a.sequence >= signalEventIndex &&
        a.sequence < eventIndex &&
        (a.actionKey
          ? (pack.actions.get(a.actionKey)?.targets.includes(leader.id) ?? false)
          : false),
    );
    if (
      action !== undefined &&
      leader.id !== 'hyp.other' &&
      leader.p >= 0.5 &&
      strongSupport.length > 0 &&
      !testsLeader &&
      !actedOnLeader &&
      (decision.relative ?? 0) < 0.5 &&
      decision.best?.actionKey !== actionKey
    ) {
      const label =
        observationEvidence.get(strongSupport[0]?.id ?? '')?.label ?? 'an earlier signal';
      hits.push({
        category: 'high_value_signal_unused',
        detail: `“${label}” already pointed to “${leaderName}” (${pct(leader.p)}) but the step did not test it.`,
      });
    }

    const lighter =
      action && action.customerEffortScore >= HIGH_EFFORT_SCORE
        ? decision.candidates.find(
            (c) =>
              c.actionKey !== actionKey &&
              config.effortScale[pack.actions.get(c.actionKey)?.customerEffort ?? 'none'] <=
                action.customerEffortScore - 0.3,
          )
        : undefined;
    if (action && lighter && (decision.relative ?? 0) < 0.6) {
      hits.push({
        category: 'disproportionate_customer_effort',
        detail: `Customer effort ${round(action.customerEffortScore, 2)} versus ${round(lighter.inputs.customerEffort, 2)} for “${lighter.label}”.`,
      });
    }

    if (action?.lowValue) {
      // Decision-time reasons only: the retrospective information-gain note is hindsight and stays out of detection.
      const reasons = action.lowValueReasons.filter((r) => !r.startsWith('Retrospectively'));
      hits.push({ category: 'low_value_action', detail: reasons.join(' ') });
    }

    if (
      action &&
      decision.relative !== null &&
      decision.relative < 0.6 &&
      decision.best &&
      decision.best.actionKey !== actionKey &&
      actionCostOf(decision.actual, config) >= MIN_MEANINGFUL_COST &&
      !isHygieneAction(packAction, config)
    ) {
      hits.push({
        category: 'alternative_action_available',
        detail: `Scored ${pct(decision.relative)} of “${decision.best.label}”.`,
      });
    }
    if (hits.length === 0) return;

    hits.sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
    const primary = hits[0];
    if (!primary) return;
    const additional = [...new Set(hits.slice(1).map((h) => h.category))].filter(
      (c) => c !== primary.category,
    );

    // ---- impact -------------------------------------------------------------------------------
    const relative = decision.relative ?? RELATIVE_PROXY[primary.category];
    const sev = Math.max(...hits.map((h) => SEVERITY_BASE[h.category]));
    const best = decision.best;
    const actualEig = decision.actual?.inputs.expectedInformationGainBits ?? 0;
    const eigShare = best
      ? clamp(
          (best.inputs.expectedInformationGainBits - actualEig) /
            config.normalization.maxInformationBits,
          0,
          1,
        )
      : 0;
    const impact = round(clamp(0.45 * (1 - relative) + 0.35 * sev + 0.2 * eigShare, 0, 1), 3);
    if (impact < policies.forkMinimumImpact) return;

    // ---- information boundary ----------------------------------------------------------------
    const before = decision.analysis.view;
    const visibleIds = new Set(before.events.map((e) => e.id));
    const evidenceBefore = input.evidence.filter((e) => visibleIds.has(e.eventId));
    const claimsBefore = claims.filter(
      (c) =>
        (c.eventId !== null && visibleIds.has(c.eventId)) ||
        (c.eventId === null && c.timestamp < event.timestamp),
    );
    const evidenceIdsBefore = new Set(evidenceBefore.map((e) => e.id));

    const topEvidenceFor = (hypothesisIds: readonly string[]): string[] => {
      const picked: { id: string; logLr: number }[] = [];
      for (const h of hypothesisIds) {
        picked.push(...evidenceEffectFor(timeline, eventIndex, h).supporting.slice(0, 2));
      }
      const unique = new Map<string, number>();
      for (const p of picked)
        if (evidenceIdsBefore.has(p.id)) unique.set(p.id, Math.max(unique.get(p.id) ?? 0, p.logLr));
      if (unique.size === 0) {
        for (const s of evidenceEffectFor(timeline, eventIndex, leader.id).supporting.slice(0, 2)) {
          if (evidenceIdsBefore.has(s.id)) unique.set(s.id, s.logLr);
        }
      }
      return [...unique.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);
    };

    const alternatives: ForkAlternative[] = decision.candidates
      .filter((c) => c.actionKey !== actionKey)
      .slice(0, MAX_ALTERNATIVES)
      .map((c) =>
        alternativeFrom(
          c,
          pack,
          belief,
          topEvidenceFor(pack.actions.get(c.actionKey)?.targets ?? []),
        ),
      );
    const bestAlternative = alternatives[0];
    const bestBreakdown = decision.candidates.find(
      (c) => c.actionKey === bestAlternative?.actionKey,
    );

    // ---- consequences & uncertainty ----------------------------------------------------------
    const actualConsequence = consequenceFor(actionKey, action, pack, config);
    const altConsequence = bestAlternative
      ? consequenceFor(bestAlternative.actionKey, undefined, pack, config)
      : null;
    const deltas: string[] = [];
    if (altConsequence) {
      const dTime =
        actualConsequence.timeToUsefulEvidenceMinutes.mid -
        altConsequence.timeToUsefulEvidenceMinutes.mid;
      const dEffort = actualConsequence.customerEffortScore - altConsequence.customerEffortScore;
      const dInfo = (bestAlternative?.expectedInformationGainBits ?? 0) - actualEig;
      if (Math.abs(dTime) >= 10)
        deltas.push(
          `about ${Math.round(Math.abs(dTime))} minutes ${dTime > 0 ? 'faster' : 'slower'}`,
        );
      if (Math.abs(dEffort) >= 0.1)
        deltas.push(
          `${Math.round(Math.abs(dEffort) * 100)}% ${dEffort > 0 ? 'less' : 'more'} customer effort`,
        );
      if (Math.abs(dInfo) >= 0.1)
        deltas.push(
          `${round(Math.abs(dInfo), 2)} bits ${dInfo > 0 ? 'more' : 'less'} expected information`,
        );
    }
    const deltaSummary =
      bestAlternative && deltas.length > 0
        ? `Estimated, not measured: “${bestAlternative.label}” would have been ${deltas.join(', ')} than the step taken.`
        : bestAlternative
          ? `Estimated, not measured: “${bestAlternative.label}” was the best-ranked safe alternative at this moment.`
          : 'No safe alternative could be ranked at this moment.';

    const scenarioRanks = bestBreakdown?.sensitivity.scenarios.map((s) => s.rank) ?? [];
    const stable =
      scenarioRanks.length === 0
        ? 1
        : scenarioRanks.filter((r) => r <= 2).length / scenarioRanks.length;
    const uncertaintyScore = round(clamp(1 - stable * 0.7 - leader.p * 0.3, 0, 1), 3);
    const rankStability = round(stable, 3);

    // ---- narrative ---------------------------------------------------------------------------
    const actionLabel =
      action?.label ?? (assumption ? assumption.text : (event.title ?? 'Statement'));
    const { title, summary } = narrate({
      category: primary.category,
      actionLabel,
      leaderName,
      leaderP: leader.p,
      targetMass,
      relative: decision.relative,
      bestLabel: best?.label ?? bestAlternative?.label ?? 'a lower-cost check',
      missing:
        primary.category === 'premature_escalation'
          ? missingEscalation.map((r) => pack.requirements.get(r)?.label ?? r)
          : missingNow,
      detail: primary.detail,
      effortMinutes: action ? effortMinutes(action) : 0,
      bestEffortScore: bestBreakdown?.inputs.customerEffort ?? 0,
      actualEffortScore: action?.customerEffortScore ?? 0,
      bestInfo: bestBreakdown?.inputs.expectedInformationGainBits ?? 0,
      actualInfo: actualEig,
      anchorName: anchor ? hypName(anchor.hypothesisId) : null,
      anchorP: anchor?.pBefore ?? 0,
      claimText: assumption?.text ?? null,
      time: formatUtcStamp(event.timestamp),
    });

    const checks = [
      {
        id: 'boundary-excludes-future',
        passed: before.events.every((e) => e.timestamp <= event.timestamp && e.id !== event.id),
        detail: `The analysis window contains ${before.events.length} events recorded before ${formatUtcStamp(event.timestamp)}; later events were withheld.`,
      },
      {
        id: 'resolution-excluded',
        passed: before.resolution === null,
        detail: 'The final resolution and root cause are excluded from the window.',
      },
      {
        id: 'alternatives-use-prior-information',
        passed: alternatives.every((a) =>
          a.supportingEvidenceIds.every((id) => evidenceIdsBefore.has(id)),
        ),
        detail: 'Every alternative cites only evidence observed before the decision.',
      },
      {
        id: 'safe-alternative-exists',
        passed: alternatives.some((a) => a.safe),
        detail: alternatives.some((a) => a.safe)
          ? 'At least one safe alternative was available.'
          : 'No safe alternative was available.',
      },
      {
        id: 'impact-meaningful',
        passed: impact >= policies.forkMinimumImpact,
        detail: `Impact ${impact} versus threshold ${policies.forkMinimumImpact}.`,
      },
    ];
    const eligibleReasons = checks.filter((c) => !c.passed).map((c) => c.detail);

    const responders = responderClosure(events, event.id);
    const newEvidence = responders.flatMap((e) => evidenceByEvent.get(e.id) ?? []);
    const retrospective = action
      ? {
          realizedInformationGainBits: action.realizedInformationGainBits,
          outcomeSummary:
            newEvidence.length > 0
              ? `Hindsight: the responses that followed produced ${newEvidence.length} observation${newEvidence.length === 1 ? '' : 's'} (${[...new Set(newEvidence.map((e) => e.label))].slice(0, 3).join('; ')}) worth ${round(action.realizedInformationGainBits, 2)} bits.`
              : `Hindsight: no new diagnostic observation followed this step (${round(action.realizedInformationGainBits, 2)} bits).`,
          usedHindsight: true as const,
        }
      : null;

    const informationUnavailable = [
      ...missingNow.map((label) => `${label} (not yet collected)`),
      'The final root cause and resolution (not known at this point)',
    ];

    forks.push({
      ...metaOf(ctx),
      id: stableId('fork', ctx.caseId, event.id),
      caseId: ctx.caseId,
      analysisRunId: ctx.runId,
      sequence: 0,
      timestamp: event.timestamp,
      eventId: event.id,
      title,
      summary,
      category: primary.category,
      additionalCategories: additional,
      severity: levelOf(impact, 0.7, EARLIEST_MEANINGFUL_IMPACT),
      impactScore: impact,
      isEarliestMeaningful: false,
      ruleIds: hits.map((h) => RULE_IDS[h.category]),
      actual: {
        actionKey,
        label: actionLabel.slice(0, 240),
        kind: packAction?.kind ?? action?.kind ?? null,
        eventId: event.id,
        customerEffort: action?.customerEffort ?? 'none',
        operationalRisk: action?.operationalRisk ?? 0,
        destructive: action?.destructive ?? false,
        actionValue: decision.actual ? decision.actual.score : null,
        relativeValue: decision.relative,
      },
      informationAvailable: {
        eventIds: before.events.map((e) => e.id),
        evidenceIds: evidenceBefore.map((e) => e.id),
        claimIds: claimsBefore.map((c) => c.id),
        summary: `${before.events.length} events and ${evidenceBefore.length} evidence items were on record. Leading hypothesis: “${leaderName}” (${pct(leader.p)} model estimate).${missingNow.length > 0 ? ` Still missing: ${missingNow.slice(0, 3).join('; ')}.` : ''}`,
      },
      informationUnavailable,
      posteriorAtDecision: topHypotheses(belief, 5).map((t) => ({
        hypothesisId: hypothesisRecordId(ctx.caseId, t.id),
        key: t.id,
        name: hypName(t.id),
        confidence: round(t.p, 3),
      })),
      alternatives,
      consequences: { actual: actualConsequence, bestAlternative: altConsequence, deltaSummary },
      uncertainty: {
        level: levelOf(uncertaintyScore, 0.55, 0.3),
        score: uncertaintyScore,
        rationale: `Best alternative stays in the top two in ${pct(stable)} of weight-perturbation scenarios; leading hypothesis at ${pct(leader.p)}. These are model estimates.`,
        rankStability,
      },
      risk: riskLevelOf(
        Math.max(
          action?.operationalRisk ?? 0,
          primary.category === 'premature_escalation' ? 0.3 : 0,
        ),
      ),
      eligibility: {
        eligible: eligibleReasons.length === 0,
        boundary: event.timestamp,
        checks,
        reasons: eligibleReasons,
      },
      retrospective,
      reviewState: 'pending',
      reviewReason: null,
    });
  });

  forks.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  forks.forEach((f, i) => {
    f.sequence = i;
  });
  const earliest =
    forks.find((f) => f.impactScore >= EARLIEST_MEANINGFUL_IMPACT && f.eligibility.eligible) ??
    null;
  if (earliest) earliest.isEarliestMeaningful = true;
  return { forks, earliestMeaningfulForkId: earliest?.id ?? null };
}

interface NarrationInput {
  category: ForkCategory;
  actionLabel: string;
  leaderName: string;
  leaderP: number;
  targetMass: number;
  relative: number | null;
  bestLabel: string;
  missing: string[];
  detail: string;
  effortMinutes: number;
  bestEffortScore: number;
  actualEffortScore: number;
  bestInfo: number;
  actualInfo: number;
  anchorName: string | null;
  anchorP: number;
  claimText: string | null;
  time: string;
}

function narrate(n: NarrationInput): { title: string; summary: string } {
  const missing = n.missing.slice(0, 3).join('; ');
  switch (n.category) {
    case 'premature_destructive_action':
      return {
        title: 'Disruptive change made before the cause was established',
        summary: `“${n.actionLabel}” went ahead while the hypothesis it targets stood at ${pct(n.targetMass)} (the leading explanation was “${n.leaderName}” at ${pct(n.leaderP)})${missing ? ` and confirming evidence was still missing: ${missing}` : ''}. Lower-risk diagnostic steps were available first.`,
      };
    case 'premature_escalation':
      return {
        title: 'Escalated before the minimum evidence was in hand',
        summary: `The case was escalated while required items were still missing (${missing || n.detail}). Collecting them first would have given the receiving team what it needs and might have made the escalation unnecessary.`,
      };
    case 'assumption_as_fact':
      return {
        title: 'Cause stated as fact without supporting evidence',
        summary: `“${(n.claimText ?? n.actionLabel).slice(0, 160)}” was written as an established conclusion, but no supporting diagnostic evidence was on record and the leading explanation was “${n.leaderName}” (${pct(n.leaderP)}).`,
      };
    case 'contradiction_ignored':
      return {
        title: 'Working hypothesis conflicted with evidence on record',
        summary: n.anchorName
          ? `Work continued on “${n.anchorName}” (${pct(n.anchorP)} at that point) although evidence already on record favoured “${n.leaderName}” (${pct(n.leaderP)}).`
          : `A statement conflicted with evidence already on record, which favoured “${n.leaderName}” (${pct(n.leaderP)}).`,
      };
    case 'high_value_signal_unused':
      return {
        title: 'A strong early signal was not acted on',
        summary: `${n.detail} The step taken instead (“${n.actionLabel}”) scored ${n.relative === null ? 'lower' : pct(n.relative)} of the best alternative, “${n.bestLabel}”.`,
      };
    case 'disproportionate_customer_effort':
      return {
        title: 'Heavy customer request when a lighter ask was available',
        summary: `“${n.actionLabel}” asked the customer for substantial effort (about ${n.effortMinutes} customer minutes, estimated). “${n.bestLabel}” promised ${n.bestInfo > n.actualInfo ? 'more' : 'comparable'} information for ${Math.round(Math.max(0, n.actualEffortScore - n.bestEffortScore) * 100)}% less customer effort.`,
      };
    case 'low_value_action':
      return {
        title: /repeat/i.test(n.detail)
          ? 'Repeated diagnostic with no new information'
          : 'Low-value diagnostic step',
        summary: n.detail,
      };
    case 'alternative_action_available':
      return {
        title: 'A higher-value next step was available',
        summary: `${n.detail} The step taken scored lower on expected information per unit of time, effort, tokens and risk.`,
      };
  }
}
