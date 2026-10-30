import {
  ACTION_VALUE_FORMULA,
  analyzeView,
  createTemporalViewBeforeEvent,
  hypothesisRecordId,
  round,
  toBreakdowns,
  type TemporalView,
} from '@caseguard/domain';
import type { ActionRanking } from '@caseguard/schemas';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { BodyOf, QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import type { AnalysisInputs } from '../analysis/inputs';
import type { RankingCore, ViewComputation, ViewDeps } from './computation';
import { canonicalInstant, compareText } from './instants';
import { loadOverrides, type OverrideScan } from './overrides';
import { recordReview, requireReason } from './reviews';
import { loadViewState, requireRun } from './state';

export const ACTION_VALUE_NOTICE =
  'Scores come from a configurable decision-support heuristic, not a scientific measurement. Actions blocked by the safety policy are never recommended, whatever their score. A reviewer override is recorded and audited next to the machine rank, which is never replaced.';

/** Where a ranking is evaluated: an instant, or the moment just before a fork's decision. */
interface RankingTarget {
  readonly inputs: AnalysisInputs;
  readonly instant: string;
  /**
   * The window the ranking is a decision-time view of, or null for the whole record. Inside a window
   * a reviewer's override made after it is invisible, entirely (see the policy in `overlay.ts`).
   */
  readonly asOf: string | null;
  readonly computation: ViewComputation;
  readonly key: string;
  readonly build: () => RankingCore;
}

function rankingCore(inputs: AnalysisInputs, view: TemporalView): RankingCore {
  const caseId = inputs.caseRecord.id;
  const analysis = analyzeView(view, inputs.pack, caseId);
  const { candidates, blocked } = toBreakdowns(
    inputs.pack,
    inputs.actionConfig,
    analysis.rankingState,
  );
  const posterior = Object.entries(analysis.belief)
    .map(([key, confidence]) => ({
      hypothesisId: hypothesisRecordId(caseId, key),
      key,
      name: inputs.pack.hypotheses.get(key)?.name ?? key,
      confidence: round(confidence, 3),
    }))
    .sort((a, b) => b.confidence - a.confidence || compareText(a.key, b.key));
  return { posterior, candidates, blocked };
}

async function resolveTarget(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: { readonly asOf?: string | undefined; readonly forkId?: string | undefined },
): Promise<RankingTarget> {
  const state = await loadViewState(ctx, caseId);
  const run = requireRun(state);
  const { inputs } = state;

  if (query.forkId !== undefined) {
    const fork = await ctx.repos.analysis.getFork(caseId, query.forkId);
    if (fork === null) throw new NotFoundError('Decision fork', query.forkId);
    return {
      inputs,
      instant: fork.timestamp,
      asOf: fork.timestamp,
      computation: deps.cache.computation(ctx, inputs, run, null),
      key: `fork:${fork.id}`,
      // Strictly before the decision: neither the step itself nor anything later is in the view.
      build: () => rankingCore(inputs, createTemporalViewBeforeEvent(inputs.events, fork.eventId)),
    };
  }

  const last = inputs.events[inputs.events.length - 1];
  const instant = query.asOf ?? last?.timestamp ?? inputs.caseRecord.openedAt;
  const computation = deps.cache.computation(ctx, inputs, run, instant);
  return {
    inputs,
    instant,
    asOf: query.asOf ?? null,
    computation,
    key: 'at',
    build: () => rankingCore(inputs, computation.view),
  };
}

/** The override scan for a ranking: its own instant, the window it is a view of (null: whole record), the pack's action names. */
function scanOverrides(
  ctx: RequestContext,
  caseId: string,
  target: RankingTarget,
  knownBy: string | null,
): Promise<OverrideScan> {
  return loadOverrides(ctx, caseId, {
    instant: target.instant,
    knownBy,
    nameOf: (actionKey) => target.inputs.pack.actions.get(actionKey)?.label,
  });
}

function assemble(target: RankingTarget, overrides: OverrideScan): ActionRanking {
  const { inputs } = target;
  const core = target.computation.rankingFor(target.key, target.build);
  return {
    caseId: inputs.caseRecord.id,
    asOf: target.instant,
    configVersion: inputs.actionConfig.version,
    formula: ACTION_VALUE_FORMULA,
    notice: ACTION_VALUE_NOTICE,
    posterior: core.posterior,
    // Candidates keep the machine order; the override sits next to the machine rank, never over it.
    // Only the override about this ranking's own instant is inline; the list holds every one it may show.
    candidates: core.candidates.map((candidate) => ({
      ...candidate,
      override: overrides.inline.get(candidate.actionKey) ?? null,
    })),
    blocked: core.blocked,
    reviewerOverrides: [...overrides.listed],
  };
}

/**
 * Ranks the candidate next actions with the transparent calculation and its weight sensitivity, at an
 * instant (events up to then) or, with `forkId`, at the moment just before that fork's decision. No
 * model is called, nothing is read from after the instant, and blocked actions are never candidates.
 * The reviewer overrides the view may show come with it (see `loadOverrides` for the window rule).
 */
export async function rankActions(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'actionValue.rank'>,
): Promise<ActionRanking> {
  const target = await resolveTarget(ctx, deps, caseId, query);
  return assemble(target, await scanOverrides(ctx, caseId, target, target.asOf));
}

/**
 * Records a reviewer's preferred rank for one candidate action at an instant. The machine rank and
 * score are preserved; an action the safety policy blocks cannot be ranked by an override. The review
 * record (with the reason) and the audit event (ids and ranks only) commit together.
 */
export async function overrideAction(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  body: BodyOf<'actionValue.override'>,
): Promise<ActionRanking> {
  const reason = requireReason(body.reason);
  const target = await resolveTarget(ctx, deps, caseId, { asOf: body.asOf });
  const core = target.computation.rankingFor(target.key, target.build);

  const candidate = core.candidates.find((entry) => entry.actionKey === body.actionKey);
  if (candidate === undefined) {
    const blocked = core.blocked.some((entry) => entry.actionKey === body.actionKey);
    throw new ValidationFailedError(
      blocked
        ? 'The safety policy blocks this action at that instant, so a review cannot rank it'
        : 'This action is not ranked at that instant',
      [
        {
          path: 'body.actionKey',
          message: blocked ? 'Blocked by the safety policy' : 'Unknown action',
        },
      ],
    );
  }
  if (body.rank > core.candidates.length) {
    throw new ValidationFailedError('The rank is beyond the candidate list', [
      { path: 'body.rank', message: `Use a rank from 1 to ${core.candidates.length}` },
    ]);
  }

  await ctx.repos.transaction(async (tx) => {
    const decision = await recordReview(ctx, tx, {
      caseId,
      targetType: 'action_value',
      targetId: `${canonicalInstant(target.instant)}|${body.actionKey}`,
      decision: 'override',
      originalValue: { rank: candidate.rank, score: candidate.score },
      newValue: { rank: body.rank },
      reason,
      permission: 'actionvalue:override',
    });
    await ctx.audit(
      {
        action: 'actionvalue.overridden',
        targetType: 'action_value',
        targetId: body.actionKey,
        caseId,
        outcome: 'success',
        details: {
          reviewId: decision.id,
          actionKey: body.actionKey,
          asOf: canonicalInstant(target.instant),
          machineRank: candidate.rank,
          rank: body.rank,
        },
      },
      tx,
    );
  });

  // The reviewer who just decided sees the whole record, their own override included.
  return assemble(target, await scanOverrides(ctx, caseId, target, null));
}
