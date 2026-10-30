'use client';

import type { RouteId } from '@caseguard/schemas';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useApiQuery } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useBreadcrumbLabel } from '../../lib/breadcrumbs';

/** Everything that shows a skill is stale once a lifecycle step, a version decision, a rollback or a validation ran. */
export const SKILL_INVALIDATES: readonly RouteId[] = [
  'skills.get',
  'skills.list',
  'skills.versions',
  'skills.diff',
  'skillMatches.list',
  'analytics.overview',
  'dashboard.commandCenter',
];

/** Reloads every view of the skills (after a background job finished, or a refusal that shows the page is out of date). */
export function useRefreshSkills(): () => void {
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  return useCallback(() => {
    void invalidateRoutes(queryClient, identityKey, SKILL_INVALIDATES);
  }, [queryClient, identityKey]);
}

/** The skill with its versions, validations, approvals, matches and the steps this caller may take (`skills.get`). */
export function useSkillDetail(skillId: string, allowed = true) {
  const auth = useAuth();
  const query = useApiQuery(
    'skills.get',
    { params: { skillId } },
    { enabled: auth.status === 'ready' && allowed, placeholderData: keepPreviousData },
  );
  useBreadcrumbLabel(`skill:${skillId}`, query.data?.skill.name);
  return query;
}

/** Analysed cases (the ones a skill can be matched, applied or validated against), from the list the header already loads. */
export function useAnalysedCases() {
  const auth = useAuth();
  const query = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const items = (query.data?.items ?? []).filter((item) => item.analysisState === 'analyzed');
  return { ...query, analysed: items };
}
