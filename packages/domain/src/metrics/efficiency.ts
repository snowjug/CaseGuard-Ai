import type { CaseEvent, DiagnosticAction } from '@caseguard/schemas';
import { findDiagnosisIndex } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import { evidenceLink, truncate } from '../quality/links';
import { round } from '../util/math';
import type { EvidenceLink } from '@caseguard/schemas';
import type { AvoidableEffortEstimate } from './ase-model';

/** Where a number comes from: telemetry recorded on the case events, or a knowledge-pack estimate. */
export type FigureBasis = 'measured' | 'estimated' | 'mixed' | 'unavailable';

export interface LabelledFigure {
  value: number | null;
  basis: FigureBasis;
  /** Plain-language explanation shown next to the number (including why it is null). */
  note: string;
}

export interface UnitPrices {
  /** Operator-supplied USD per 1,000 tokens. Never hard-coded; null means "not configured". */
  inputPer1kUsd: number | null;
  outputPer1kUsd: number | null;
  cachedInputPer1kUsd?: number | null;
}

export interface CheaperEquivalent {
  eventId: string;
  chosenLabel: string;
  chosenTokens: number;
  chosenBasis: 'measured' | 'estimated';
  /** Null when the step simply did not need to run (an exact repeat). */
  alternativeActionKey: string | null;
  alternativeLabel: string;
  alternativeTokens: number;
  savedTokens: number;
  rationale: string;
  evidence: EvidenceLink[];
}

export interface EfficiencyReport {
  tokens: {
    measured: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      total: number;
      events: number;
    };
    estimated: { total: number; actions: number };
    total: LabelledFigure;
  };
  perUsefulEvidence: LabelledFigure;
  usefulEvidenceItems: number;
  perDiagnosis: LabelledFigure;
  waste: {
    tokens: LabelledFigure;
    share: number | null;
    actionEventIds: string[];
  };
  compute: {
    measuredSeconds: LabelledFigure;
    estimatedUnits: LabelledFigure;
  };
  /** Information gained per 1,000 tokens (the token-efficiency metric). */
  bitsPer1kTokens: LabelledFigure;
  cheaperEquivalents: CheaperEquivalent[];
  cost: { usd: number | null; basis: FigureBasis; reason: string };
  /** Tokens of the real path versus the best valid simulated alternative (both estimates). */
  caseProcess: {
    actualTokens: number;
    counterfactualTokens: number | null;
    estimatedSavingsPct: number | null;
    caseId: string | null;
  };
  labels: { measured: boolean; estimated: true; synthetic: boolean };
  notes: string[];
}

export interface EfficiencyInput {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  caseId: string;
  /** True for synthetic cases: even "measured" telemetry is then simulated and is labelled so. */
  synthetic: boolean;
  /** Cost is computed only when the operator supplies unit prices. */
  unitPrices?: UnitPrices;
  /** Supplies the real-versus-alternative token comparison when an estimate exists. */
  avoidable?: AvoidableEffortEstimate;
}

const tokensOfEvent = (event: CaseEvent): number =>
  event.ai ? event.ai.promptTokens + event.ai.completionTokens : 0;

function actionTokens(
  action: DiagnosticAction,
  pack: CompiledPack,
): { tokens: number; basis: 'measured' | 'estimated' } {
  if (action.tokenEstimate > 0) return { tokens: action.tokenEstimate, basis: 'measured' };
  const packEstimate = action.actionKey
    ? (pack.actions.get(action.actionKey)?.tokenEstimate ?? 0)
    : 0;
  return { tokens: packEstimate, basis: 'estimated' };
}

const figure = (value: number | null, basis: FigureBasis, note: string): LabelledFigure => ({
  value,
  basis,
  note,
});

/**
 * Token and compute efficiency for one case (spec 5.14). Measured values come from `event.ai`
 * telemetry; steps without telemetry fall back to knowledge-pack estimates and are labelled
 * "estimated". No price is ever assumed: cost is reported only for operator-supplied unit prices.
 */
export function computeEfficiency(input: EfficiencyInput): EfficiencyReport {
  const { analysis, pack, caseId, synthetic } = input;
  const events = analysis.view.events;
  const telemetry = events.filter((e) => e.ai !== null);
  const prompt = telemetry.reduce((s, e) => s + (e.ai?.promptTokens ?? 0), 0);
  const completion = telemetry.reduce((s, e) => s + (e.ai?.completionTokens ?? 0), 0);
  const cached = telemetry.reduce((s, e) => s + (e.ai?.cachedTokens ?? 0), 0);
  const measuredTotal = prompt + completion;

  const perAction = analysis.actions.map((action) => ({ action, ...actionTokens(action, pack) }));
  const estimatedParts = perAction.filter((p) => p.basis === 'estimated' && p.tokens > 0);
  const estimatedTotal = estimatedParts.reduce((s, p) => s + p.tokens, 0);
  const total = measuredTotal + estimatedTotal;
  const totalBasis: FigureBasis =
    measuredTotal > 0 && estimatedTotal > 0
      ? 'mixed'
      : measuredTotal > 0
        ? 'measured'
        : estimatedTotal > 0
          ? 'estimated'
          : 'unavailable';

  const usefulEvidence = new Set(analysis.links.map((l) => l.evidenceId));
  const useful = usefulEvidence.size;

  const diagnosis = findDiagnosisIndex(pack, analysis.timeline, analysis.requirementStates, 0);
  const uptoDiagnosis = diagnosis
    ? events.slice(0, diagnosis.index + 1).reduce((s, e) => s + tokensOfEvent(e), 0) +
      estimatedParts
        .filter((p) => p.action.sequence <= diagnosis.index)
        .reduce((s, p) => s + p.tokens, 0)
    : null;

  const wasteParts = perAction.filter((p) => p.action.lowValue && p.tokens > 0);
  const wasted = wasteParts.reduce((s, p) => s + p.tokens, 0);
  const wasteBasis: FigureBasis =
    wasteParts.length === 0
      ? 'unavailable'
      : wasteParts.every((p) => p.basis === 'measured')
        ? 'measured'
        : wasteParts.every((p) => p.basis === 'estimated')
          ? 'estimated'
          : 'mixed';

  const computeSeconds = events.reduce((s, e) => s + (e.ai?.computeSeconds ?? 0), 0);
  const hasComputeTelemetry = events.some((e) => e.ai?.computeSeconds !== undefined);
  const computeUnits = analysis.actions.reduce((s, a) => s + a.computeUnits, 0);

  const bitsTotal = analysis.timeline.steps.reduce((s, step) => s + step.gainBits, 0);
  const bitsTokens = measuredTotal > 0 ? measuredTotal : estimatedTotal;
  const bitsBasis: FigureBasis =
    measuredTotal > 0 ? 'measured' : estimatedTotal > 0 ? 'estimated' : 'unavailable';

  const equivalents: CheaperEquivalent[] = [];
  for (const part of perAction) {
    const { action } = part;
    if (!action.lowValue || part.tokens <= 0) continue;
    const fork = analysis.forks.find((f) => f.eventId === action.eventId);
    const alternative = fork?.alternatives.find((a) => a.safe && a.tokenEstimate < part.tokens);
    const evidence = [evidenceLink('action', action.id, action.label)];
    if (action.isRepeat) {
      equivalents.push({
        eventId: action.eventId,
        chosenLabel: action.label,
        chosenTokens: part.tokens,
        chosenBasis: part.basis,
        alternativeActionKey: null,
        alternativeLabel: 'Reuse the earlier result instead of running it again',
        alternativeTokens: 0,
        savedTokens: part.tokens,
        rationale:
          'This step repeated earlier work; reusing the earlier result avoids the whole cost.',
        evidence,
      });
    } else if (alternative) {
      equivalents.push({
        eventId: action.eventId,
        chosenLabel: action.label,
        chosenTokens: part.tokens,
        chosenBasis: part.basis,
        alternativeActionKey: alternative.actionKey,
        alternativeLabel: alternative.label,
        alternativeTokens: alternative.tokenEstimate,
        savedTokens: part.tokens - alternative.tokenEstimate,
        rationale: truncate(
          `A safe alternative that was available at that moment: ${alternative.rationale}`,
          400,
        ),
        evidence: [...evidence, evidenceLink('fork', fork?.id ?? action.eventId, fork?.title)],
      });
    }
  }
  equivalents.sort((a, b) => b.savedTokens - a.savedTokens || (a.eventId < b.eventId ? -1 : 1));

  const prices = input.unitPrices;
  let cost: EfficiencyReport['cost'];
  if (!prices || prices.inputPer1kUsd === null || prices.outputPer1kUsd === null) {
    cost = {
      usd: null,
      basis: 'unavailable',
      reason:
        'No unit prices were supplied. Prices are never hard-coded; configure the operator unit prices to see an estimated cost.',
    };
  } else if (measuredTotal === 0) {
    cost = {
      usd: null,
      basis: 'unavailable',
      reason:
        'No token telemetry was recorded, and estimated tokens have no prompt/completion split to price.',
    };
  } else {
    const cachedPrice = prices.cachedInputPer1kUsd ?? prices.inputPer1kUsd;
    const uncached = Math.max(0, prompt - cached);
    const usd =
      (uncached / 1000) * prices.inputPer1kUsd +
      (cached / 1000) * cachedPrice +
      (completion / 1000) * prices.outputPer1kUsd;
    cost = {
      usd: round(usd, 6),
      basis: 'estimated',
      reason:
        'Computed from recorded token telemetry and the supplied unit prices; estimated tokens are not priced.',
    };
  }

  const tokenComponent = input.avoidable?.components.find(
    (c) => c.key === 'token_usage' && c.included,
  );
  const actualWindowTokens = tokenComponent ? Math.round(tokenComponent.total) : total;
  const counterfactualTokens = tokenComponent
    ? Math.max(0, Math.round(tokenComponent.total - tokenComponent.avoidable.mid))
    : null;

  const notes = [
    synthetic
      ? 'This case is synthetic: even the recorded telemetry is simulated and demonstrates the measurement pipeline only.'
      : 'Recorded telemetry comes from the original support process; knowledge-pack estimates fill the gaps and are labelled.',
    'Information gain is a model estimate from hypothesis updates, not a measurement of customer value.',
  ];

  return {
    tokens: {
      measured: {
        promptTokens: prompt,
        completionTokens: completion,
        cachedTokens: cached,
        total: measuredTotal,
        events: telemetry.length,
      },
      estimated: { total: estimatedTotal, actions: estimatedParts.length },
      total: figure(
        total > 0 ? total : null,
        totalBasis,
        total > 0
          ? `${measuredTotal} tokens recorded on ${telemetry.length} events plus ${estimatedTotal} estimated for ${estimatedParts.length} steps without telemetry.`
          : 'No token telemetry or estimate is available.',
      ),
    },
    usefulEvidenceItems: useful,
    perUsefulEvidence: figure(
      useful > 0 && total > 0 ? round(total / useful, 1) : null,
      useful > 0 && total > 0 ? totalBasis : 'unavailable',
      useful > 0
        ? `Total tokens divided by the ${useful} evidence items that moved a hypothesis.`
        : 'No evidence item has moved a hypothesis yet.',
    ),
    perDiagnosis: figure(
      uptoDiagnosis !== null && uptoDiagnosis > 0 ? uptoDiagnosis : null,
      uptoDiagnosis !== null && uptoDiagnosis > 0 ? totalBasis : 'unavailable',
      diagnosis
        ? 'Tokens spent up to the event at which a diagnosis was confirmed.'
        : 'No diagnosis has been confirmed in this view.',
    ),
    waste: {
      tokens: figure(
        wasteParts.length > 0 ? wasted : null,
        wasteBasis,
        wasteParts.length > 0
          ? `Tokens on ${wasteParts.length} repeated or low-value steps (flagged at decision time).`
          : 'No repeated or low-value step consumed tokens.',
      ),
      share: wasteParts.length > 0 && total > 0 ? round(wasted / total, 3) : null,
      actionEventIds: wasteParts.map((p) => p.action.eventId),
    },
    compute: {
      measuredSeconds: figure(
        hasComputeTelemetry ? round(computeSeconds, 1) : null,
        hasComputeTelemetry ? 'measured' : 'unavailable',
        hasComputeTelemetry
          ? 'Compute seconds recorded on event telemetry.'
          : 'No compute telemetry was recorded.',
      ),
      estimatedUnits: figure(
        computeUnits,
        'estimated',
        'Sum of knowledge-pack compute units of the steps taken (illustrative estimates).',
      ),
    },
    bitsPer1kTokens: figure(
      bitsTokens > 0 ? round(bitsTotal / (bitsTokens / 1000), 3) : null,
      bitsBasis,
      bitsTokens > 0
        ? 'Information gained from hypothesis updates per 1,000 tokens of the case process.'
        : 'No token telemetry or estimate is available.',
    ),
    cheaperEquivalents: equivalents.slice(0, 5),
    cost,
    caseProcess: {
      actualTokens: actualWindowTokens,
      counterfactualTokens,
      estimatedSavingsPct:
        tokenComponent && tokenComponent.total > 0 ? tokenComponent.pct.mid : null,
      caseId,
    },
    labels: { measured: telemetry.length > 0, estimated: true, synthetic },
    notes,
  };
}
