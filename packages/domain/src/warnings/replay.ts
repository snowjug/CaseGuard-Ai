import {
  DEFAULT_ACTION_VALUE_CONFIG,
  RESPONSIBLE_USE_NOTICE,
  type ActionValueConfig,
  type CaseEvent,
  type CaseResolution,
  type CaseWarning,
  type WarningCategory,
  WARNING_CATEGORIES,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import { runDeterministicAnalysis, type DeterministicAnalysis } from '../engine/pipeline';
import { createFullView, createTemporalView } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';
import { buildCheckpoint } from './checkpoint';
import {
  advanceLifecycle,
  applyDismissals,
  createLifecycleState,
  lifecycleFrom,
  rankWarnings,
  WarningDismissalSchema,
  type LifecycleState,
} from './lifecycle';
import { evaluateRules, ruleDeadlines } from './rules';
import { isAfter, isBefore } from './helpers';
import {
  DEFAULT_LIVE_WARNING_OPTIONS,
  type Checkpoint,
  type LiveWarningOptions,
  type WarningCandidate,
  type WarningDismissal,
  type WarningTransition,
} from './types';

export interface WarningCounts {
  total: number;
  open: number;
  resolved: number;
  dismissed: number;
  /** Open warnings per category (zero for categories without any). */
  openByCategory: Record<WarningCategory, number>;
}

export function countWarnings(warnings: readonly CaseWarning[]): WarningCounts {
  const openByCategory = Object.fromEntries(WARNING_CATEGORIES.map((c) => [c, 0])) as Record<
    WarningCategory,
    number
  >;
  let open = 0;
  let resolved = 0;
  let dismissed = 0;
  for (const w of warnings) {
    if (w.state === 'open') {
      open += 1;
      openByCategory[w.category] += 1;
    } else if (w.state === 'resolved') resolved += 1;
    else dismissed += 1;
  }
  return { total: warnings.length, open, resolved, dismissed, openByCategory };
}

export interface LiveWarningInput {
  /** Analysis of the view being evaluated: the whole case, or a prefix ending at the evaluation instant. */
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  ctx: EngineContext;
  config?: ActionValueConfig;
  /** Evaluation instant; defaults to the timestamp of the last event in the view. */
  now?: string;
  /** Warnings from earlier evaluations, so the lifecycle (open, resolved, dismissed) continues. */
  previous?: readonly CaseWarning[];
  dismissals?: readonly WarningDismissal[];
  options?: Partial<LiveWarningOptions>;
}

export interface LiveWarningEvaluation {
  evaluatedAt: string;
  /** Conditions that hold right now, before dedupe and lifecycle. */
  candidates: WarningCandidate[];
  /** Every warning after this evaluation, ranked (open first). */
  warnings: CaseWarning[];
  open: CaseWarning[];
  transitions: WarningTransition[];
}

/**
 * Evaluates the live quality rules for one instant using only the events in the analysed view, and
 * continues the lifecycle of `previous` warnings. Rules never see anything beyond the view.
 */
export function evaluateLiveWarnings(input: LiveWarningInput): LiveWarningEvaluation {
  const { analysis, pack, ctx } = input;
  const config = input.config ?? DEFAULT_ACTION_VALUE_CONFIG;
  const options = { ...DEFAULT_LIVE_WARNING_OPTIONS, ...input.options };
  const index = analysis.view.events.length - 1;
  const last = analysis.view.events[index];
  const now = input.now ?? last?.timestamp ?? analysis.view.asOf;
  const cp = buildCheckpoint({ analysis, pack, config, options, index, now });
  const candidates = evaluateRules(cp);
  const dismissals = (input.dismissals ?? []).map((d) => WarningDismissalSchema.parse(d));
  const state = lifecycleFrom(input.previous ?? []);
  advanceLifecycle({ state, cp, candidates, dismissals, ctx });
  const warnings = rankWarnings([...state.warnings.values()]);
  return {
    evaluatedAt: now,
    candidates,
    warnings,
    open: warnings.filter((w) => w.state === 'open'),
    transitions: state.transitions,
  };
}

/**
 * Presents warnings as they were known at `asOf`: later warnings are withheld, resolutions and
 * dismissals made after `asOf` are not yet known (the warning shows as open), and ranks are
 * recomputed over what is visible.
 */
export function viewWarningsAsOf(warnings: readonly CaseWarning[], asOf: string): CaseWarning[] {
  const visible = warnings
    .filter((w) => !isAfter(w.raisedAt, asOf))
    .map((w): CaseWarning => {
      const resolvedLater = w.resolvedAt !== null && isAfter(w.resolvedAt, asOf);
      const dismissedLater = w.dismissal !== null && isAfter(w.dismissal.at, asOf);
      if (!resolvedLater && !dismissedLater) return w;
      return {
        ...w,
        state: 'open',
        resolvedAt: null,
        resolvedReason: null,
        dismissal: null,
      };
    });
  return rankWarnings(visible);
}

export interface WarningReplayInput {
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  pack: CompiledPack;
  ctx: EngineContext;
  config?: ActionValueConfig;
  /**
   * Replay only information known at this instant: the analysis runs on the prefix of events up to
   * it, so nothing recorded later (and no later resolution) can influence the result.
   */
  asOf?: string;
  /** Reuse an analysis already computed for exactly this view (skipped when the view differs). */
  analysis?: DeterministicAnalysis;
  dismissals?: readonly WarningDismissal[];
  options?: Partial<LiveWarningOptions>;
}

export interface WarningReplay {
  asOf: string | null;
  evaluatedAt: string;
  checkpoints: number;
  /** All warnings as of the replay boundary, ranked (open first). */
  warnings: CaseWarning[];
  open: CaseWarning[];
  counts: WarningCounts;
  /** Audit trail: raised, resolved, superseded, dismissed and suppressed, in order. */
  transitions: WarningTransition[];
  /** Dismissals that matched no open warning at or before the boundary. */
  unmatchedDismissals: WarningDismissal[];
  notice: string;
}

export const WARNING_NOTICE = `Live quality warnings are supportive prompts based on rules over the case record, not judgements. ${RESPONSIBLE_USE_NOTICE}`;

const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

/**
 * Replays the live quality layer over a case. The analysis is built once for the view up to `asOf`
 * (strictly prefix-only), the evaluation advances event by event (and at waiting deadlines between
 * events), and each checkpoint sees only information known then. Warnings are raised once,
 * resolve automatically when their condition stops holding, and dismissed ones stay dismissed.
 */
export function replayWarnings(input: WarningReplayInput): WarningReplay {
  const { events, resolution, pack, ctx } = input;
  const config = input.config ?? DEFAULT_ACTION_VALUE_CONFIG;
  const options = { ...DEFAULT_LIVE_WARNING_OPTIONS, ...input.options };
  const dismissals = (input.dismissals ?? []).map((d) => WarningDismissalSchema.parse(d));
  const asOf = input.asOf ?? null;

  const view =
    asOf !== null
      ? createTemporalView(events, asOf, { resolution })
      : createFullView(events, resolution);
  const analysis =
    input.analysis && input.analysis.view.fingerprint === view.fingerprint
      ? input.analysis
      : runDeterministicAnalysis({ view, pack, config, ctx });

  const state: LifecycleState = createLifecycleState();
  const visible = analysis.view.events;
  let checkpoints = 0;
  const run = (cp: Checkpoint): void => {
    checkpoints += 1;
    advanceLifecycle({ state, cp, candidates: evaluateRules(cp), dismissals, ctx });
  };
  visible.forEach((event, index) => {
    const cp = buildCheckpoint({ analysis, pack, config, options, index, now: event.timestamp });
    run(cp);
    const next = visible[index + 1];
    for (const deadline of ruleDeadlines(cp)) {
      // A deadline is evaluated only if it falls before the next event and inside the boundary.
      if (next ? !isBefore(deadline, next.timestamp) : asOf === null || isAfter(deadline, asOf)) {
        continue;
      }
      run(buildCheckpoint({ analysis, pack, config, options, index, now: deadline }));
    }
  });

  const cutoff = asOf ?? FAR_FUTURE;
  const evaluatedAt = asOf ?? visible[visible.length - 1]?.timestamp ?? analysis.view.asOf;
  applyDismissals(state, dismissals, cutoff);
  const warnings = rankWarnings([...state.warnings.values()]);
  return {
    asOf,
    evaluatedAt,
    checkpoints,
    warnings,
    open: warnings.filter((w) => w.state === 'open'),
    counts: countWarnings(warnings),
    transitions: state.transitions,
    unmatchedDismissals: dismissals.filter(
      (d) => !isAfter(d.at, cutoff) && !state.applied.has(`${d.dedupeKey}@${d.at}`),
    ),
    notice: WARNING_NOTICE,
  };
}
