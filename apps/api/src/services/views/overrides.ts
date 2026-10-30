import {
  ACTION_OVERRIDES_LISTED_MAX,
  type ActionOverrideRecord,
  type ActionValueBreakdown,
  type ReviewDecision,
} from '@caseguard/schemas';
import { z } from 'zod';
import type { ReviewRepository } from '../../db';
import { canonicalInstant, parseCanonicalInstant } from './instants';

/** Reviewer overrides are found by scanning the case's review decisions, newest first. */
export const OVERRIDE_PAGE = 200;
export const OVERRIDE_MAX_PAGES = 25;

const OverrideValueSchema = z.object({ rank: z.number().int().min(1) });
/** The shape of a knowledge-pack action key; the body of an override bounds it to 80 characters. */
const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** The override a candidate shows inline. */
export type StoredOverride = NonNullable<ActionValueBreakdown['override']>;

/** What the override scan needs of a request: the review repository and a logger. */
export interface OverrideSource {
  readonly repos: { readonly reviews: Pick<ReviewRepository, 'list'> };
  readonly logger: { warn(details: object, message: string): void };
}

export interface OverrideQuery {
  /** The ranking's own instant: the overrides recorded about it are shown inline on its candidates. */
  readonly instant: string;
  /** The end of the window the ranking is a view of, or null for the whole record. */
  readonly knownBy: string | null;
  /** The knowledge pack's name for an action, when it has one. */
  readonly nameOf: (actionKey: string) => string | undefined;
}

export interface OverrideScan {
  /** The latest override visible for each action at the ranking's own instant. */
  readonly inline: ReadonlyMap<string, StoredOverride>;
  /** Every override the view may show, newest decision first, at most `ACTION_OVERRIDES_LISTED_MAX`. */
  readonly listed: readonly ActionOverrideRecord[];
}

interface ParsedOverride {
  /** The decision's target id, `<canonical ranking instant>|<action key>`: one override per pair. */
  readonly pair: string;
  readonly instant: string;
  readonly instantMs: number;
  readonly actionKey: string;
  readonly rank: number;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  readonly atMs: number;
}

/**
 * An override as `overrideAction` writes it. A decision with another kind, an id that is not
 * `<canonical instant>|<action key>` or a value that is not a rank is ignored, so a forged record can
 * neither crash the scan nor appear in a view.
 */
function parseOverride(decision: ReviewDecision): ParsedOverride | null {
  if (decision.targetType !== 'action_value' || decision.decision !== 'override') return null;
  const split = decision.targetId.indexOf('|');
  if (split < 0) return null;
  const instant = decision.targetId.slice(0, split);
  const actionKey = decision.targetId.slice(split + 1);
  const instantMs = parseCanonicalInstant(instant);
  const atMs = Date.parse(decision.decidedAt);
  const value = OverrideValueSchema.safeParse(decision.newValue);
  if (instantMs === null || Number.isNaN(atMs) || !ACTION_KEY.test(actionKey) || !value.success) {
    return null;
  }
  return {
    pair: decision.targetId,
    instant,
    instantMs,
    actionKey,
    rank: value.data.rank,
    reason: decision.reason,
    by: decision.reviewerId,
    at: decision.decidedAt,
    atMs,
  };
}

/**
 * The reviewer overrides of a case that a view may show. An override is recorded about one ranking
 * instant and one action, so a case holds one current override per (instant, action) pair and the
 * latest decision wins. Inside a window (`knownBy` is its end) an override takes part only when it was
 * decided by then AND is about an instant at or before it (see the policy in `overlay.ts`): the latest
 * decision made by then is the current one, and everything else leaves no trace at all, not even a
 * count: the result is a function of the decisions made up to the window's end, and of nothing after
 * it. The whole record (`knownBy` null) shows every pair.
 *
 * Only `action_value` decisions of the case are read (the repository filters them in the database),
 * newest first, OVERRIDE_PAGE at a time, up to OVERRIDE_MAX_PAGES pages; this one pass builds both the
 * inline map and the list. If that bound is reached with more decisions left, the older ones are not
 * read and that is logged with the case id and the number of decisions scanned, never silently; so is
 * a list cut at `ACTION_OVERRIDES_LISTED_MAX`. Logs hold counts only, never a reviewer's reason.
 */
export async function loadOverrides(
  ctx: OverrideSource,
  caseId: string,
  query: OverrideQuery,
): Promise<OverrideScan> {
  const own = canonicalInstant(query.instant);
  const end = query.knownBy === null ? null : Date.parse(query.knownBy);
  // A window whose end is not a valid instant knows nothing: the comparison is false for NaN.
  const inWindow = (ms: number): boolean => end === null || ms <= end;

  const visible = new Map<string, ParsedOverride>();
  let cursor: string | undefined;
  let scanned = 0;
  for (let pages = 0; ; pages++) {
    const page = await ctx.repos.reviews.list({
      caseId,
      targetType: 'action_value',
      limit: OVERRIDE_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    scanned += page.items.length;
    for (const decision of page.items) {
      const parsed = parseOverride(decision);
      if (parsed === null) continue;
      // Newest first: the first decision seen inside the window is the current one for its pair, and
      // the order the pairs are first seen in is the order of their current decisions, newest first.
      if (visible.has(parsed.pair) || !inWindow(parsed.atMs) || !inWindow(parsed.instantMs))
        continue;
      visible.set(parsed.pair, parsed);
    }
    if (page.nextCursor === null) break;
    if (pages + 1 >= OVERRIDE_MAX_PAGES) {
      ctx.logger.warn(
        { caseId, scanned, bound: OVERRIDE_MAX_PAGES * OVERRIDE_PAGE },
        'The scan for reviewer overrides reached its bound; older decisions were not read',
      );
      break;
    }
    cursor = page.nextCursor;
  }

  const inline = new Map<string, StoredOverride>();
  for (const entry of visible.values()) {
    if (entry.instant === own) {
      inline.set(entry.actionKey, {
        rank: entry.rank,
        reason: entry.reason,
        by: entry.by,
        at: entry.at,
      });
    }
  }
  if (visible.size > ACTION_OVERRIDES_LISTED_MAX) {
    ctx.logger.warn(
      { caseId, overrides: visible.size, listed: ACTION_OVERRIDES_LISTED_MAX },
      'More reviewer overrides than a ranking lists; the oldest decisions are not listed',
    );
  }
  const listed = [...visible.values()]
    .slice(0, ACTION_OVERRIDES_LISTED_MAX)
    .map((entry): ActionOverrideRecord => ({
      instant: entry.instant,
      actionKey: entry.actionKey,
      actionName: query.nameOf(entry.actionKey) ?? entry.actionKey,
      rank: entry.rank,
      reason: entry.reason,
      by: entry.by,
      at: entry.at,
    }));
  return { inline, listed };
}
