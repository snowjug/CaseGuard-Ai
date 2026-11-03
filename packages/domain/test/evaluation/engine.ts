import {
  COUNTERFACTUAL_STRATEGIES,
  DEFAULT_QUALITY_CONFIG,
  type EvidenceLink,
} from '@caseguard/schemas';
import {
  TEAMS_AUTH_PACK,
  buildCoachingReport,
  computeQualityReview,
  generateCounterfactuals,
  getCompiledPack,
  replayWarnings,
  verifyExcerpt,
  type CompiledPack,
} from '../../src';
import { CONFIG, prepareBundle, type Prepared } from '../helpers';
import { caseToBundle } from './bundle';
import { canonicalJson, sha256 } from './dataset';
import {
  CLEARLY_BETTER,
  refusedOutput,
  type CitationCounts,
  type CounterfactualOutput,
  type EngineCaseOutput,
  type EngineEventInfo,
  type MissCause,
  type RecommendationCounts,
} from './output';
import type { EvalCase } from './schema';

/**
 * The one place where the evaluation runs the engine. It turns an evaluation case into the plain data the measures read
 * (`EngineCaseOutput`) and nothing else: it never looks at a label.
 */

export interface RunOptions {
  /** Quality improvements, warnings and coaching suggestions, for the evidence-link measure. Default: on. */
  readonly recommendations?: boolean;
  /** Simulated better paths at the earliest decision point. Slow, so opt-in. Default: off. */
  readonly counterfactual?: boolean;
  /** `eventKey|signalId` pairs to explain if the engine does not report them. Diagnostics only. */
  readonly explainMisses?: readonly string[];
}

const caseIdFor = (id: string): string => `case_${id.replace(/[^a-z0-9]/g, '_')}`;

/** Maps the ids the engine gives events back to the keys of the case file. */
function keysOf(source: EvalCase, engineIds: readonly string[]): Map<string, string> {
  const keys = source.events.map((event) => event.key).sort((a, b) => b.length - a.length);
  const out = new Map<string, string>();
  for (const id of engineIds) {
    const key = keys.find((candidate) => id.endsWith(candidate));
    if (!key) throw new Error(`${source.id}: no event of the case file for the engine event ${id}`);
    out.set(id, key);
  }
  return out;
}

/**
 * Why a signal could not have been read from an event, decided from how the pack's detectors are defined:
 *  - `structured-only`: every detector of the signal reads structured event data, so free text cannot show it;
 *  - `type-or-role-gate`: the signal has text detectors, but none accepts this event's type or author role;
 *  - `wording`: a text detector accepts the event, so its pattern did not match what was written.
 */
export function classifyMiss(
  pack: CompiledPack,
  signalId: string,
  event: { readonly type: string; readonly participantRole: string },
): MissCause {
  const detectors = pack.pack.signals.find((signal) => signal.id === signalId)?.detectors ?? [];
  const text = detectors.filter((detector) => detector.kind === 'regex');
  if (text.length === 0) return 'structured-only';
  const accepted = text.some(
    (detector) =>
      (!detector.eventTypes || detector.eventTypes.some((type) => type === event.type)) &&
      (!detector.roles || detector.roles.some((role) => role === event.participantRole)),
  );
  return accepted ? 'wording' : 'type-or-role-gate';
}

interface HasEvidence {
  readonly evidence: readonly EvidenceLink[];
}

function recommendationCounts(prepared: Prepared): {
  counts: RecommendationCounts;
  band: string;
} {
  const { normalized, pack, ctx, analysis } = prepared;
  const review = computeQualityReview({
    analysis,
    pack,
    ctx,
    config: DEFAULT_QUALITY_CONFIG,
    actionConfig: CONFIG,
  });
  const replay = replayWarnings({
    events: normalized.events,
    resolution: normalized.resolution,
    pack,
    ctx,
    config: CONFIG,
    analysis,
  });
  const coaching = buildCoachingReport({
    analysis,
    pack,
    ctx,
    review,
    warnings: replay.warnings,
    skills: [],
    config: CONFIG,
    synthetic: normalized.case.synthetic,
  });
  const items: HasEvidence[] = [
    ...review.improvements,
    ...replay.warnings,
    ...coaching.evidenceQuality,
    ...coaching.reasoningImprovements,
    ...coaching.communicationImprovements,
    ...coaching.customerEffortImprovements,
    ...(coaching.missedOpportunity ? [coaching.missedOpportunity] : []),
    ...(coaching.recommendedNextAction ? [coaching.recommendedNextAction] : []),
  ];
  let withEvidence = 0;
  let general = 0;
  for (const item of items) {
    if (item.evidence.length > 0) withEvidence += 1;
    // The engine has no such flag yet: an output with no evidence ids counts as general guidance only if it says so.
    else if ((item as { generalGuidance?: unknown }).generalGuidance === true) general += 1;
  }
  return { counts: { total: items.length, withEvidence, general }, band: review.band };
}

function counterfactualOutput(prepared: Prepared): CounterfactualOutput {
  const { analysis, normalized, pack, ctx } = prepared;
  const fork = analysis.forks.find((candidate) => candidate.isEarliestMeaningful && candidate.eligibility.eligible);
  if (!fork) {
    return { simulated: false, timeToDiagnosisGain: null, customerEffortGain: null, clearlyBetter: false };
  }
  const { scenarios } = generateCounterfactuals({
    analysis,
    fork,
    strategies: COUNTERFACTUAL_STRATEGIES,
    events: normalized.events,
    resolution: normalized.resolution,
    pack,
    config: CONFIG,
    ctx,
  });
  const best = (key: string): number | null => {
    const gains = scenarios
      .filter((scenario) => scenario.status === 'completed')
      .map((scenario) => scenario.improvements[key])
      .filter((gain): gain is number => typeof gain === 'number');
    return gains.length > 0 ? Math.max(...gains) : null;
  };
  const time = best('timeToDiagnosisMinutesPct');
  const effort = best('customerEffortMinutesPct');
  return {
    simulated: true,
    timeToDiagnosisGain: time,
    customerEffortGain: effort,
    clearlyBetter: (time ?? 0) >= CLEARLY_BETTER || (effort ?? 0) >= CLEARLY_BETTER,
  };
}

/** Runs the engine on one case. A workload without a knowledge pack is refused, as the product refuses it. */
export function runEngine(source: EvalCase, options: RunOptions = {}): EngineCaseOutput {
  const whoOf = new Map(source.events.map((event) => [event.key, event.who]));
  const byTime = [...source.events].sort((a, b) => a.at - b.at);
  const pack = getCompiledPack(source.workload);
  if (!pack) {
    return refusedOutput(
      source.id,
      byTime.map((event) => ({ key: event.key, type: event.type, role: event.who, who: event.who })),
    );
  }

  const prepared = prepareBundle(caseToBundle(source), caseIdFor(source.id));
  const { normalized, analysis } = prepared;
  const keyOf = keysOf(
    source,
    normalized.events.map((event) => event.id),
  );
  const key = (eventId: string): string => keyOf.get(eventId) ?? eventId;
  const events: EngineEventInfo[] = normalized.events.map((event) => ({
    key: key(event.id),
    type: event.type,
    role: event.participantRole,
    who: whoOf.get(key(event.id)) ?? '',
  }));
  const eventByKey = new Map(normalized.events.map((event) => [key(event.id), event]));

  const reported = new Set<string>();
  for (const item of analysis.evidence) reported.add(`${key(item.eventId)}|${item.signalId}`);
  const actions = new Set<string>();
  for (const action of analysis.actions) {
    if (action.actionKey !== null) actions.add(`${key(action.eventId)}|${action.actionKey}`);
  }

  const citations: { -readonly [K in keyof CitationCounts]: CitationCounts[K] } = {
    total: 0,
    verified: 0,
    mismatch: 0,
    notCheckable: 0,
  };
  const cite = (eventId: string | null, ref: Parameters<typeof verifyExcerpt>[1]): void => {
    const event = eventId === null ? undefined : normalized.events.find((candidate) => candidate.id === eventId);
    const check = verifyExcerpt(event ?? { id: '', title: null, body: '' }, ref);
    citations.total += 1;
    if (check.verification === 'verified') citations.verified += 1;
    else if (check.verification === 'mismatch') citations.mismatch += 1;
    else citations.notCheckable += 1;
  };
  for (const item of analysis.evidence) cite(item.eventId, item.sourceRef);
  for (const claim of analysis.claims) if (claim.sourceRef) cite(claim.eventId, claim.sourceRef);

  const missCauses: Record<string, MissCause> = {};
  for (const pair of options.explainMisses ?? []) {
    if (reported.has(pair)) continue;
    const [eventKey = '', signalId = ''] = pair.split('|');
    const event = eventByKey.get(eventKey);
    if (event) missCauses[pair] = classifyMiss(pack, signalId, event);
  }

  const earliest = analysis.forks.find((fork) => fork.isEarliestMeaningful);
  const fingerprint = JSON.stringify({
    evidence: [...reported].sort(),
    forks: analysis.forks.map((fork) => [key(fork.eventId), fork.category, fork.severity]),
    hypotheses: analysis.hypotheses.map((hypothesis) => [
      hypothesis.key,
      Math.round(hypothesis.currentConfidence * 1e6),
    ]),
  });

  const withRecommendations = options.recommendations !== false;
  const recommended = withRecommendations ? recommendationCounts(prepared) : null;
  return {
    caseId: source.id,
    refused: false,
    events,
    signals: [...reported].sort(),
    actions: [...actions].sort(),
    forks: analysis.forks.map((fork) => ({
      event: key(fork.eventId),
      categories: [fork.category, ...fork.additionalCategories],
      severity: fork.severity,
      earliest: fork.isEarliestMeaningful,
    })),
    earliestFork: earliest ? key(earliest.eventId) : null,
    // The engine does not report conflicts yet. When it does, map its output here (event keys, class, subject).
    conflicts: 'not_available',
    hypotheses: analysis.hypotheses.map((hypothesis) => ({
      key: hypothesis.key,
      prior: hypothesis.prior,
      confidence: hypothesis.currentConfidence,
    })),
    citations,
    recommendations: recommended ? recommended.counts : null,
    qualityBand: recommended ? recommended.band : null,
    counterfactual: options.counterfactual ? counterfactualOutput(prepared) : null,
    missCauses,
    fingerprint,
  };
}

/** Who and what produced the numbers of a run, for the log of locked runs and the baseline file. */
export function enginePackIdentity(): { id: string; version: string; sha256: string } {
  return {
    id: TEAMS_AUTH_PACK.id,
    version: TEAMS_AUTH_PACK.version,
    sha256: sha256(canonicalJson(TEAMS_AUTH_PACK)),
  };
}
