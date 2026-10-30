import {
  ACTION_VALUE_FORMULA,
  analyzeView,
  createTemporalViewBeforeEvent,
  hypothesisRecordId,
  round,
  toBreakdowns,
  type TemporalView,
} from '@caseguard/domain';
import type { ActionRanking, ActionValueBreakdown } from '@caseguard/schemas';
import { z } from 'zod';
import type { ReviewRepository } from '../../db';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { BodyOf, QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import type { AnalysisInputs } from '../analysis/inputs';
import type { RankingCore, ViewComputation, ViewDeps } from './computation';
import { canonicalInstant, compareText } from './instants';
import { knownInWindow } from './overlay';
import { recordReview, requireReason } from './reviews';
import { loadViewState, requireRun } from './state';

export const ACTION_VALUE_NOTICE =
  'Scores come from a configurable decision-support heuristic, not a scientific measurement. Actions blocked by the safety policy are never recommended, whatever their score. A reviewer override is recorded and audited next to the machine rank, which is never replaced.';

/** Reviewer overrides of one instant are found by scanning the case's review decisions, newest first. */
export const OVERRIDE_PAGE = 200;
export const OVERRIDE_MAX_PAGES = 25;
const REVIEW_PAGE = OVERRIDE_PAGE;
const MAX_REVIEW_PAGES = OVERRIDE_MAX_PAGES;

const OverrideValueSchema = z.object({ rank: z.number().int().min(1) });

type StoredOverride = NonNullable<ActionValueBreakdown['override']>;

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

/** What the override scan needs of a request: the review repository and a logger. */
export interface OverrideSource {
  readonly repos: { readonly reviews: Pick<ReviewRepository, 'list'> };
  readonly logger: { warn(details: object, message: string): void };
}

/**
 * The override a reviewer recorded for each action at this instant; the latest decision wins. Inside
 * a window (`knownBy` is its boundary) only decisions made by then count, so the latest of those is
 * the current one and a later override leaves no trace at all.
 *
 * Only `action_value` decisions of the case are read (the repository filters them in the database),
 * newest first, REVIEW_PAGE at a time, up to MAX_REVIEW_PAGES pages. If that bound is reached with more
 * decisions left, the overrides beyond it are not read, and that is logged with the case id and the
 * number of decisions scanned, never silently.
 */
export async function loadOverrides(
  ctx: OverrideSource,
  caseId: string,
  instant: string,
  knownBy: string | null,
): Promise<Map<string, StoredOverride>> {
  const prefix = `${canonicalInstant(instant)}|`;
  const found = new Map<string, StoredOverride>();
  let cursor: string | undefined;
  let scanned = 0;
  for (let pages = 0; ; pages++) {
    const page = await ctx.repos.reviews.list({
      caseId,
      targetType: 'action_value',
      limit: REVIEW_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    scanned += page.items.length;
    for (const decision of page.items) {
      if (decision.targetType !== 'action_value' || !decision.targetId.startsWith(prefix)) continue;
      if (!knownInWindow(decision.decidedAt, knownBy)) continue;
      const actionKey = decision.targetId.slice(prefix.length);
      const value = OverrideValueSchema.safeParse(decision.newValue);
      // Decisions arrive newest first, so the first one seen for an action is the current one.
      if (found.has(actionKey) || !value.success) continue;
      found.set(actionKey, {
        rank: value.data.rank,
        reason: decision.reason,
        by: decision.reviewerId,
        at: decision.decidedAt,
      });
    }
    if (page.nextCursor === null) break;
    if (pages + 1 >= MAX_REVIEW_PAGES) {
      ctx.logger.warn(
        { caseId, scanned, bound: MAX_REVIEW_PAGES * REVIEW_PAGE },
        'The scan for reviewer overrides reached its bound; older decisions were not read',
      );
      break;
    }
    cursor = page.nextCursor;
  }
  return found;
}

function assemble(
  target: RankingTarget,
  overrides: ReadonlyMap<string, StoredOverride>,
): ActionRanking {
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
    candidates: core.candidates.map((candidate) => ({
      ...candidate,
      override: overrides.get(candidate.actionKey) ?? null,
    })),
    blocked: core.blocked,
  };
}

/**
 * Ranks the candidate next actions with the transparent calculation and its weight sensitivity, at an
 * instant (events up to then) or, with `forkId`, at the moment just before that fork's decision. No
 * model is called, nothing is read from after the instant, and blocked actions are never candidates.
 */
export async function rankActions(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'actionValue.rank'>,
): Promise<ActionRanking> {
  const target = await resolveTarget(ctx, deps, caseId, query);
  return assemble(target, await loadOverrides(ctx, caseId, target.instant, target.asOf));
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
  return assemble(target, await loadOverrides(ctx, caseId, target.instant, null));
}
