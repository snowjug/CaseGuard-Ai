'use client';

import type { ActionExecutor } from '@caseguard/schemas';
import { useMemo } from 'react';
import {
  useCoachingHandle,
  useQualityHandle,
  useRankingHandle,
  useScenariosHandle,
  useWarningsHandle,
  type Handle,
} from './hooks';
import { deriveNextActions, type NextActionsModel } from './model/actions';

export interface NextActionsState {
  model: NextActionsModel;
  /** The reads the list is built from, so a part that could not be read can be named and retried. */
  handles: {
    quality: Handle<unknown>;
    coaching: Handle<unknown>;
    warnings: Handle<unknown>;
    ranking: Handle<unknown>;
  };
  /** True while any of the reads is still loading. */
  loading: boolean;
  /** The warnings, once read: the list says what became of them even when none is open. */
  warningsRead: boolean;
}

/**
 * The ranked fixes of a case, built from the quality improvements, the open warnings, the coach and the ranked
 * diagnostic steps. The section that lists them and the page's "Copy fix list" action both use it; the reads are
 * shared through the query cache, so using it twice costs no extra request.
 */
export function useNextActions(caseId: string): NextActionsState {
  const quality = useQualityHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const warnings = useWarningsHandle(caseId);
  const ranking = useRankingHandle(caseId);
  const scenarios = useScenariosHandle(caseId);

  const qualityData = quality.source.kind === 'ready' ? quality.source.data : null;
  const coachingData = coaching.source.kind === 'ready' ? coaching.source.data : null;
  const warningData = warnings.source.kind === 'ready' ? warnings.source.data : null;
  const rankingData = ranking.source.kind === 'ready' ? ranking.source.data : null;
  const scenarioData = scenarios.source.kind === 'ready' ? scenarios.source.data : null;

  const executors = useMemo(() => {
    const map = new Map<string, ActionExecutor>();
    for (const scenario of scenarioData ?? [])
      for (const step of scenario.steps)
        if (!map.has(step.actionKey)) map.set(step.actionKey, step.executor);
    return map;
  }, [scenarioData]);

  const model = useMemo(
    () =>
      deriveNextActions({
        quality: qualityData,
        warnings: warningData,
        coaching: coachingData,
        ranking: rankingData,
        executors,
      }),
    [qualityData, warningData, coachingData, rankingData, executors],
  );

  const handles = { quality, coaching, warnings, ranking };
  return {
    model,
    handles,
    loading: Object.values(handles).some((handle) => handle.source.kind === 'loading'),
    warningsRead: warningData !== null,
  };
}
