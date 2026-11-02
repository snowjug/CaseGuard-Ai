import {
  ROUTES,
  type Permission,
  type ProvenanceResponse,
  type Role,
  type RouteId,
  type SkillOverlay,
} from '@caseguard/schemas';
import { ApiError } from '../src/lib/api/errors';
import { linkKey, parseLinkKey } from '../src/features/review/model/links';
import { fakeApi, type FakeApi, type FakeHandlers } from './harness';
import { session } from './fixtures';
import {
  CASE_ONE,
  OVERLAY_ONE,
  OVERLAY_TWO,
  PROVENANCE_ONE,
  type CaseFixture,
} from './review-fixtures';

/** What each role may do, as the API's role matrix says (packages/security/src/rbac.ts), for the permissions that matter here. */
export const PERMISSIONS_BY_ROLE: Record<Exclude<Role, 'administrator'>, readonly Permission[]> = {
  engineer: [
    'case:read',
    'case:ingest',
    'case:analyze',
    'counterfactual:run',
    'skill:read',
    'skill:apply',
    'skill:extract',
    'warning:dismiss',
    'quality:read',
  ],
  reviewer: ['case:read', 'skill:read', 'quality:read', 'counterfactual:review', 'quality:review'],
  manager: ['case:read', 'quality:read', 'analytics:read', 'skill:read'],
  skill_curator: ['case:read', 'skill:read', 'skill:extract', 'skill:apply', 'skill:review'],
};

export function forbidden(permission: Permission): ApiError {
  return new ApiError({
    status: 403,
    code: 'forbidden',
    title: 'Forbidden',
    message: `Your role does not include the "${permission}" permission.`,
  });
}

/** The provenance response for exactly the links asked for: what is known is resolved, the rest is reported. */
export function provenanceFor(
  query: { links?: string } | undefined,
  known: ProvenanceResponse = PROVENANCE_ONE,
): ProvenanceResponse {
  const asked = (query?.links ?? '')
    .split(',')
    .map((key) => parseLinkKey(key))
    .filter((link): link is NonNullable<typeof link> => link !== null);
  const byKey = new Map(known.items.map((item) => [linkKey(item.link), item]));
  return {
    caseId: known.caseId,
    asOf: null,
    items: asked.flatMap((link) => {
      const item = byKey.get(linkKey(link));
      return item ? [item] : [];
    }),
    unresolved: asked
      .filter((link) => !byKey.has(linkKey(link)))
      .map((link) => ({ link, reason: 'not_found' as const })),
  };
}

export interface ReviewApiOptions {
  fixture?: CaseFixture;
  role?: Exclude<Role, 'administrator'>;
  /** Replaces a handler (it still sits behind the permission check of its route). */
  handlers?: FakeHandlers;
  overlays?: Record<string, SkillOverlay>;
}

/**
 * A fake API that serves the captured output of a sample to a role, and refuses with a 403 what the role may not read,
 * exactly where the real API would. A page that asks for something it should not have asked for fails visibly.
 */
export function reviewApi(options: ReviewApiOptions = {}): FakeApi {
  const fixture = options.fixture ?? CASE_ONE;
  const role = options.role ?? 'engineer';
  const permissions = new Set<Permission>(PERMISSIONS_BY_ROLE[role]);
  const overlays: Record<string, SkillOverlay> = {
    [OVERLAY_ONE.matchId]: OVERLAY_ONE,
    [OVERLAY_TWO.matchId]: OVERLAY_TWO,
    ...options.overlays,
  };
  const served: FakeHandlers = {
    'session.me': () => session(role, [...permissions]),
    'cases.get': () => fixture.detail,
    'analysis.latest': () => ({ run: fixture.run }),
    'timeline.get': () => fixture.timeline,
    'forks.list': () => fixture.forks,
    'counterfactuals.list': () => ({ items: fixture.scenarios }),
    'quality.get': () => fixture.quality,
    'metrics.get': () => ({ items: fixture.metrics }),
    'warnings.list': () => ({ items: fixture.warnings }),
    'coaching.get': () => fixture.coaching,
    'actionValue.rank': () => fixture.ranking,
    'actions.list': () => ({ items: fixture.actions }),
    'skillMatches.list': () => ({ items: fixture.matches }),
    'skillOverlay.get': (input) => {
      const matchId = (input as { params: { matchId: string } }).params.matchId;
      const overlay = overlays[matchId];
      if (!overlay)
        throw new ApiError({
          status: 404,
          code: 'not_found',
          title: 'Not found',
          message: 'No such match',
        });
      return overlay;
    },
    'provenance.resolve': (input) => provenanceFor((input as { query?: { links?: string } }).query),
    ...options.handlers,
  };
  const guarded: FakeHandlers = {};
  for (const [id, handler] of Object.entries(served) as [RouteId, (input: unknown) => unknown][]) {
    const needed = ROUTES[id].permission;
    guarded[id] =
      needed === null || permissions.has(needed)
        ? handler
        : () => {
            throw forbidden(needed);
          };
  }
  return fakeApi(guarded);
}

/** The routes the fake API was called with, in order, without the input. */
export function calledRoutes(api: FakeApi): string[] {
  return api.call.mock.calls.map((call) => String(call[0]));
}
