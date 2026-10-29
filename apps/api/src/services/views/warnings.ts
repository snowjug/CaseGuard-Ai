import type { WarningDismissal } from '@caseguard/domain';
import type { CaseWarning } from '@caseguard/schemas';
import { NotFoundError, VersionConflictError } from '../../errors';
import type { BodyOf, QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewComputation, type ViewDeps } from './computation';
import { overlayWarning } from './overlay';
import { recordReview, requireReason } from './reviews';
import { loadCaseRun, loadViewState } from './state';

/** The dismissals people have made, in the form the live-warning replay continues its lifecycle from. */
export function dismissalsOf(warnings: readonly CaseWarning[]): WarningDismissal[] {
  return warnings.flatMap((warning) =>
    warning.dismissal === null
      ? []
      : [
          {
            dedupeKey: warning.fingerprint,
            by: warning.dismissal.by,
            at: warning.dismissal.at,
            reason: warning.dismissal.reason,
          },
        ],
  );
}

/** Open warnings of a view: the stored count for the whole record, the replayed one inside a window. */
export async function openWarningCount(
  ctx: RequestContext,
  caseId: string,
  computation: ViewComputation,
): Promise<number> {
  if (computation.asOf === null) {
    return (await ctx.repos.analysis.listWarnings(caseId, { state: 'open' })).length;
  }
  const stored = await ctx.repos.analysis.listWarnings(caseId);
  return (await computation.warnings(dismissalsOf(stored))).open.length;
}

/**
 * Warnings as they stand, or as they were known at `asOf`: the live-warning rules are replayed over
 * the events up to then (a resolution or dismissal after that instant is not yet known, so the
 * warning shows as open), and the stored versions are laid over the result.
 */
export async function listWarnings(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'warnings.list'>,
): Promise<{ items: CaseWarning[] }> {
  if (query.asOf === undefined) {
    await loadCaseRun(ctx, caseId);
    const filter = query.state === 'all' ? {} : { state: query.state };
    return { items: await ctx.repos.analysis.listWarnings(caseId, filter) };
  }

  const state = await loadViewState(ctx, caseId);
  const computation = computationFor(deps, state, query.asOf);
  const stored = await ctx.repos.analysis.listWarnings(caseId);
  const replay = await computation.warnings(dismissalsOf(stored));
  const storedById = new Map(stored.map((warning) => [warning.id, warning]));
  const items = replay.warnings
    .map((warning) => overlayWarning(warning, storedById.get(warning.id)))
    .filter((warning) => query.state === 'all' || warning.state === query.state);
  return { items };
}

/**
 * Dismisses an open warning with a reason. The dismissal is version-checked, recorded as a review
 * decision and audited in one transaction; the reason never enters the audit details.
 */
export async function dismissWarning(
  ctx: RequestContext,
  caseId: string,
  warningId: string,
  body: BodyOf<'warnings.dismiss'>,
): Promise<CaseWarning> {
  const reason = requireReason(body.reason);
  await loadCaseRun(ctx, caseId);

  return ctx.repos.transaction(async (tx) => {
    const before = await tx.analysis.getWarning(caseId, warningId);
    if (before === null) throw new NotFoundError('Warning', warningId);
    if (before.version !== body.expectedVersion) {
      throw new VersionConflictError('Warning', body.expectedVersion, before.version);
    }
    const next = await tx.analysis.dismissWarning(caseId, warningId, {
      by: ctx.auth.userId,
      at: ctx.now().toISOString(),
      reason,
      expectedVersion: body.expectedVersion,
    });
    const decision = await recordReview(ctx, tx, {
      caseId,
      targetType: 'warning',
      targetId: warningId,
      decision: 'dismiss',
      originalValue: { state: before.state },
      newValue: { state: next.state },
      reason,
      permission: 'warning:dismiss',
    });
    await ctx.audit(
      {
        action: 'warning.dismissed',
        targetType: 'warning',
        targetId: warningId,
        caseId,
        outcome: 'success',
        details: {
          reviewId: decision.id,
          ruleId: before.ruleId,
          category: before.category,
          priority: before.priority,
          expectedVersion: body.expectedVersion,
          version: next.version,
        },
      },
      tx,
    );
    return next;
  });
}
