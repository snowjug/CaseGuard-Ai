'use client';

import type { RouteId } from '@caseguard/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';

/**
 * The case the page is about (reference and title for the header, first and last event for the time cursor), with the
 * breadcrumb showing its reference. One hook for every case page, shared with the other case pages.
 */
export { useCaseDetail } from '../../components/case/case-hooks';

/** Names the person behind an id the API recorded: "you" for the signed-in user, the id as recorded for anyone else. */
export function useActorLabel(): (id: string | null | undefined) => string {
  const { session } = useSession();
  const me = session?.user.id ?? null;
  return useCallback((id) => (!id ? 'someone' : id === me ? 'you' : id), [me]);
}

/** Marks the given routes stale for the current identity (and refetches the ones on screen), for example after a job. */
export function useInvalidate(): (routeIds: readonly RouteId[]) => Promise<void> {
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  return useCallback(
    (routeIds) => invalidateRoutes(queryClient, identityKey, routeIds),
    [queryClient, identityKey],
  );
}
