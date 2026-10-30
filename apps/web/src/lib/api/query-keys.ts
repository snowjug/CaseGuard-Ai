import type { RouteId } from '@caseguard/schemas';
import { ROUTES } from '@caseguard/schemas';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

type KeyInput =
  | { params?: Record<string, unknown> | undefined; query?: Record<string, unknown> | undefined }
  | undefined;

/**
 * Query-key factory. Keys are `['api', identityKey, routeId, params, query]`: partitioned by identity (a persona
 * switch can never show another persona's cached data), then by route and its inputs.
 */
export const queryKeys = {
  all: ['api'] as const,
  identity: (identityKey: string) => ['api', identityKey] as const,
  route: (identityKey: string, routeId: RouteId) => ['api', identityKey, routeId] as const,
  request: (identityKey: string, routeId: RouteId, input?: KeyInput): QueryKey => [
    'api',
    identityKey,
    routeId,
    input?.params ?? null,
    input?.query ?? null,
  ],
};

/** Freshness per API family (milliseconds). Pages can still override `staleTime` per query. */
const STALE_BY_TAG: Record<string, number> = {
  Identity: 60_000,
  Ingestion: 5 * 60_000,
  Cases: 15_000,
  Analysis: 10_000,
  Jobs: 0,
  'Case analysis': 30_000,
  'Counterfactual lab': 30_000,
  Quality: 30_000,
  SkillDNA: 30_000,
  Dashboards: 15_000,
  Governance: 30_000,
  Demo: 5_000,
  System: 10_000,
};

export function staleTimeFor(routeId: RouteId): number {
  const tag = ROUTES[routeId].tags[0];
  return (tag ? STALE_BY_TAG[tag] : undefined) ?? 15_000;
}

/** Marks every cached request of the given routes stale for this identity (refetches the ones on screen). */
export async function invalidateRoutes(
  queryClient: QueryClient,
  identityKey: string,
  routeIds: readonly RouteId[],
): Promise<void> {
  await Promise.all(
    routeIds.map((routeId) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.route(identityKey, routeId) }),
    ),
  );
}

/** Marks everything cached for this identity stale (use after a demo reset or a persona change). */
export async function invalidateAll(queryClient: QueryClient, identityKey: string): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.identity(identityKey) });
}
