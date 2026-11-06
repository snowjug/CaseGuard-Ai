'use client';

import type { AnalysisRun, CaseDetail, Job } from '@caseguard/schemas';
import {
  Button,
  CopyButton,
  ErrorState,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  RelativeTime,
  cg,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { PlayIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  useActiveAnalysisJob,
  useRefreshAnalysisViews,
} from '../../components/case/NotAnalysedState';
import { describeError, type ApiError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction } from '../../lib/auth/session';
import { PROVIDER_LABELS } from '../../lib/labels';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  counts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${cg.space[3]} ${cg.space[4]}`,
    margin: 0,
    paddingTop: cg.space[3],
    borderTop: `1px solid ${cg.borderSubtle}`,
    fontSize: tokens.fontSizeBase300,
  },
  countTerm: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  countValue: {
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: tokens.fontWeightSemibold,
  },
});

const RUN_STATUS: Record<AnalysisRun['status'], string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Where a review is in its life on this page: what to show and what may be started. */
export interface ReviewRun {
  /** The job being followed (found through the job list, or started here), if any. */
  job: Job | null;
  /** A review is queued or running: nothing else may be started until it ends. */
  busy: boolean;
  /** The progress card belongs on screen: a job that is running, or one that ended without a result. */
  showJob: boolean;
  starting: boolean;
  /** Starts a review. It rejects with a plain-language message, for a dialog to show. */
  begin: (force: boolean) => Promise<void>;
  /** Starts a review from a button: a refusal becomes a toast. */
  startPlain: () => void;
  /** To pass to the job's progress card. */
  onTerminal: (job: Job) => void;
}

/**
 * Starting and following the review of a case (the API calls it an analysis): the live job with its real stages while it
 * runs, and the two ways to start one. A review with the same input is never re-run (the stored one is reused);
 * re-running on purpose replaces the stored one, so the caller asks first.
 */
export function useReviewRun(detail: CaseDetail): ReviewRun {
  const toast = useToast();
  const refresh = useRefreshAnalysisViews();
  const [started, setStarted] = useState<Job | null>(null);
  const [ended, setEnded] = useState<{ id: string; status: Job['status'] } | null>(null);
  const live = detail.analysisState === 'queued' || detail.analysisState === 'running';
  const found = useActiveAnalysisJob(detail.id, live && started === null);
  const job = started ?? found;
  const over = job !== null && ended?.id === job.id;
  const start = useApiMutation('analysis.start', {
    invalidate: ['cases.get', 'analysis.latest', 'jobs.list'],
  });

  const begin = async (force: boolean): Promise<void> => {
    try {
      const response = await start.mutateAsync({ params: { caseId: detail.id }, body: { force } });
      if (response.reused) {
        toast.info('The stored review was reused', {
          body: 'The input is identical, so nothing had to be re-run.',
        });
        refresh();
      } else {
        setEnded(null);
        setStarted(response.job);
      }
    } catch (failure) {
      throw new Error(describeError(failure), { cause: failure });
    }
  };
  const startPlain = (): void => {
    begin(false).catch((failure: unknown) =>
      toast.error('The review could not be started', { body: describeError(failure) }),
    );
  };
  const onTerminal = (finished: Job): void => {
    setEnded({ id: finished.id, status: finished.status });
    refresh();
    if (finished.status === 'succeeded') toast.success('The review finished');
  };

  return {
    job,
    busy: live || (job !== null && !over),
    showJob: job !== null && !(over && ended?.status === 'succeeded'),
    starting: start.isPending,
    begin,
    startPlain,
    onTerminal,
  };
}

/** Runs the review of a case that has none (or whose last one failed). Disabled, with the reason, without `case:analyze`. */
export function RunReviewButton({ review, failed }: { review: ReviewRun; failed: boolean }) {
  return (
    <GatedAction permission="case:analyze">
      <Button
        variant="secondary"
        icon={<PlayIcon />}
        loading={review.starting}
        disabledFocusable={review.busy}
        onClick={review.startPlain}
      >
        {failed ? 'Retry the review' : 'Run the review'}
      </Button>
    </GatedAction>
  );
}

/** One line for the closed section: how the latest run ended, with what, and when. */
export function runSubtitle(run: AnalysisRun | null | undefined, loading: boolean): ReactNode {
  if (loading) return 'Loading…';
  if (!run) return 'No review has run yet';
  return (
    <>
      {RUN_STATUS[run.status]} · {PROVIDER_LABELS[run.provider]}
      {run.completedAt ? (
        <>
          {' · '}
          <RelativeTime value={run.completedAt} />
        </>
      ) : null}
    </>
  );
}

export interface ReviewRunDetailsProps {
  /** The latest run, `null` when there is none, `undefined` while it is unknown. */
  run: AnalysisRun | null | undefined;
  /** An analysis is queued or running. */
  live: boolean;
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  /** With a time cursor set, totals of the whole record (decisions, warnings) are not shown. */
  asOf: string | null;
}

const COUNT_LABELS: readonly [keyof AnalysisRun['counts'], string][] = [
  ['events', 'Events'],
  ['evidence', 'Evidence items'],
  ['claims', 'Claims'],
  ['hypotheses', 'Possible causes'],
  ['actions', 'Actions'],
  ['forks', 'Key decisions'],
  ['warnings', 'Warnings'],
  ['modelExecutions', 'Model executions'],
];

/**
 * How the review was made: the latest run (provider, model, versions, input hash), what it produced, and why it failed
 * when it did. Technical detail, so it sits behind an accordion; starting and re-running live elsewhere.
 */
export function ReviewRunDetails({
  run,
  live,
  loading,
  error,
  onRetry,
  asOf,
}: ReviewRunDetailsProps) {
  const styles = useStyles();
  if (loading)
    return <LoadingSkeleton variant="text" count={4} label="Loading the review details" />;
  if (error) {
    return (
      <ErrorState
        compact
        title="The review details could not be loaded"
        description={describeError(error)}
        onRetry={onRetry}
      />
    );
  }
  if (!run) {
    return (
      <p className={styles.text} role={live ? 'status' : undefined}>
        {live
          ? 'A review is queued. This section updates when it starts.'
          : 'This case has not been analysed yet. The timeline, evidence and possible causes appear once it has been.'}
      </p>
    );
  }
  return (
    <div className={styles.stack}>
      {run.status === 'failed' && run.error ? (
        <Notice variant="warning" title="The last review failed">
          {run.error}
        </Notice>
      ) : null}
      <KeyValueList
        columns={1}
        layout="inline"
        aria-label="Latest review"
        items={[
          { id: 'status', label: 'Run', value: RUN_STATUS[run.status] },
          {
            id: 'provider',
            label: 'Provider',
            value: PROVIDER_LABELS[run.provider],
            hint: run.simulated
              ? 'Rules and the knowledge pack, not a language model. Results are labelled Simulated.'
              : undefined,
          },
          { id: 'model', label: 'Model', value: run.model },
          {
            id: 'pack',
            label: 'Knowledge pack',
            value: `${run.knowledgePackId} ${run.knowledgePackVersion}`,
          },
          {
            id: 'configs',
            label: 'Configuration',
            value: `quality ${run.qualityConfigVersion}, action value ${run.actionValueConfigVersion}`,
          },
          { id: 'started', label: 'Started', value: <RelativeTime value={run.startedAt} /> },
          {
            id: 'completed',
            label: 'Completed',
            value: run.completedAt ? <RelativeTime value={run.completedAt} /> : 'Not completed',
          },
          {
            id: 'hash',
            label: 'Input hash',
            value: (
              <span>
                <span className={styles.mono}>{run.inputHash.slice(0, 16)}…</span>{' '}
                <CopyButton value={run.inputHash} label="Copy review input hash" />
              </span>
            ),
            hint: 'Identical input is never re-run.',
          },
        ]}
      />
      {asOf === null ? (
        <dl className={styles.counts} aria-label="What the review produced">
          {COUNT_LABELS.map(([key, label]) => (
            <div key={key}>
              <dt className={styles.countTerm}>{label}</dt>
              <dd className={styles.countValue}>{formatNumber(run.counts[key])}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.text}>
          Totals for the whole record (decisions, warnings, claims) are hidden while an earlier
          moment is shown.
        </p>
      )}
    </div>
  );
}
