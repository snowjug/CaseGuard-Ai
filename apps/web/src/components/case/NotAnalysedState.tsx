'use client';

import type { AnalysisState, Job, RouteId } from '@caseguard/schemas';
import { EmptyState, cg } from '@caseguard/ui';
import { Button, Spinner, makeStyles } from '@fluentui/react-components';
import { PlayRegular, SearchRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { JobProgress } from '../common/JobProgress';
import { LinkButton } from '../common/LinkButton';
import { describeError } from '../../lib/api/errors';
import { useApiMutation, useApiQuery } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { hasReason } from '../../lib/api/reason';
import { useAuth } from '../../lib/auth/context';
import { GatedAction } from '../../lib/auth/session';
import { caseHref } from '../../lib/deep-links';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
});

/** Everything that depends on a case's analysis and must be reloaded when the analysis finishes. */
const ANALYSIS_ROUTES: readonly RouteId[] = [
  'cases.get',
  'cases.list',
  'analysis.latest',
  'twin.get',
  'timeline.get',
  'evidence.list',
  'hypotheses.list',
  'events.get',
  'dashboard.commandCenter',
];

/** The `Problem.reason` of the 409 that says the case has never been analysed (see docs/API.md, reason tokens). */
export const NOT_ANALYSED_REASON = 'not_analysed';

/**
 * True for the API's answer to a case view that needs an analysis the case does not have yet: 409 `conflict` with the
 * reason `not_analysed`. Every route that can say so (the artefact views, a counterfactual run, a skill application)
 * sends the token, so the wording of the message is never read. A 409 about a stale analysis ("no longer matches the
 * engine output") is another condition and is not this one.
 */
export function isNotAnalysedError(error: unknown): boolean {
  return hasReason(error, NOT_ANALYSED_REASON, 'conflict');
}

/** Reloads every view that depends on the analysis of the case (after it started, finished or was cancelled). */
export function useRefreshAnalysisViews(): () => void {
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  return useCallback(() => {
    void invalidateRoutes(queryClient, identityKey, ANALYSIS_ROUTES);
  }, [queryClient, identityKey]);
}

export interface NotAnalysedStateProps {
  caseId: string;
  /** What the person came for, as a noun phrase: "the timeline". */
  subject: string;
  /** The case's analysis state when known (`cases.get`); decides between "start" and "watch". */
  analysisState?: AnalysisState | undefined;
}

/**
 * The queued or running analysis job of a case, found through the job list (a read that needs only `case:read`), or null.
 * Polls while `enabled` so the page notices a job that starts later.
 */
export function useActiveAnalysisJob(caseId: string, enabled: boolean): Job | null {
  const auth = useAuth();
  const jobs = useApiQuery(
    'jobs.list',
    { query: { caseId, kind: 'case_analysis', limit: 5 } },
    { enabled: auth.status === 'ready' && enabled, refetchInterval: 2000 },
  );
  return (
    jobs.data?.items.find((job) => job.status === 'queued' || job.status === 'running') ?? null
  );
}

/**
 * Shown instead of a case view when the case has no analysis yet (the API answers 409). It says so plainly, lets someone
 * with `case:analyze` start the analysis, follows the job's real stages, and reloads the views when it finishes. Where
 * an analysis is already queued or running it follows that job instead.
 */
export function NotAnalysedState({ caseId, subject, analysisState }: NotAnalysedStateProps) {
  const styles = useStyles();
  const toast = useToast();
  const refresh = useRefreshAnalysisViews();
  const [started, setStarted] = useState<Job | null>(null);
  const live = analysisState === 'queued' || analysisState === 'running';
  const found = useActiveAnalysisJob(caseId, live && started === null);
  const activeJob = started ?? found;
  const start = useApiMutation('analysis.start', { invalidate: ['cases.get', 'jobs.list'] });

  const startAnalysis = async (): Promise<void> => {
    try {
      const response = await start.mutateAsync({ params: { caseId }, body: {} });
      setStarted(response.job);
    } catch (error) {
      toast.error('The analysis could not be started', { body: describeError(error) });
    }
  };

  if (activeJob) {
    return (
      <div className={styles.stack}>
        <JobProgress
          jobId={activeJob.id}
          title="Analysing the case"
          onTerminal={(job) => {
            refresh();
            if (job.status === 'succeeded') toast.success('The analysis finished');
          }}
        />
        <p>This page fills in by itself when the analysis is done: {subject} needs it.</p>
      </div>
    );
  }

  return (
    <EmptyState
      headingLevel={2}
      icon={<SearchRegular />}
      title="This case has not been analysed yet"
      description={`The analysis rebuilds the timeline, classifies evidence and weighs the hypotheses. ${
        subject.charAt(0).toUpperCase() + subject.slice(1)
      } is available as soon as it has run.${
        live ? ' An analysis is queued: this page will update when it starts.' : ''
      }`}
      action={
        <GatedAction permission="case:analyze">
          <Button
            appearance="primary"
            disabled={start.isPending || live}
            icon={start.isPending ? <Spinner size="tiny" /> : <PlayRegular />}
            onClick={() => void startAnalysis()}
          >
            {start.isPending ? 'Starting…' : 'Start the analysis'}
          </Button>
        </GatedAction>
      }
      secondaryAction={
        <LinkButton href={caseHref(caseId)} appearance="outline">
          Back to the case overview
        </LinkButton>
      }
    />
  );
}
