'use client';

import type { CaseSummary } from '@caseguard/schemas';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';

/** Cases to choose from in a filter. Shares its cache entry with the header's case switcher (`cases.list`, 100). */
export function useCaseOptions(): readonly CaseSummary[] {
  const auth = useAuth();
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  return cases.data?.items ?? [];
}
