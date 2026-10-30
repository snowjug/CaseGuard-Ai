'use client';

import type { AnalysisRun, CaseDetail, Job } from '@caseguard/schemas';
import {
  ConfirmDialog,
  CopyButton,
  ErrorState,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatNumber,
} from '@caseguard/ui';
import { Button, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowSyncRegular, PlayRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import {
  useActiveAnalysisJob,
  useRefreshAnalysisViews,
} from '../../components/case/NotAnalysedState';
import { JobProgress } from '../../components/common/JobProgress';
import { describeError, type ApiError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction, useSession } from '../../lib/auth/session';
import { ANALYSIS_STATE_BADGES, PROVIDER_LABELS } from '../../lib/labels';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  counts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
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

export interface AnalysisPanelProps {
  detail: CaseDetail;
  run: AnalysisRun | null | undefined;
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  /** With a time cursor set, totals of the whole record (forks, warnings) are not shown. */
  asOf: string | null;
}

const COUNT_LABELS: readonly [keyof AnalysisRun['counts'], string][] = [
  ['events', 'Events'],
  ['evidence', 'Evidence items'],
  ['claims', 'Claims'],
  ['hypotheses', 'Hypotheses'],
  ['actions', 'Actions'],
  ['forks', 'Decision forks'],
  ['warnings', 'Warnings'],
  ['modelExecutions', 'Model executions'],
];

/**
 * Analysis status of the case: its state, the latest run (provider, versions, input hash, counts), the live job with its
 * real stages while it runs, and the actions to start or re-run it (re-running replaces the stored analysis, so it asks).
 */
export function AnalysisPanel({ detail, run, loading, error, onRetry, asOf }: AnalysisPanelProps) {
  const styles = useStyles();
  const toast = useToast();
  const { can } = useSession();
  const refresh = useRefreshAnalysisViews();
  const [started, setStarted] = useState<Job | null>(null);
  const live = detail.analysisState === 'queued' || detail.analysisState === 'running';
  const found = useActiveAnalysisJob(detail.id, live && started === null);
  const activeJob = started ?? found;
  const start = useApiMutation('analysis.start', {
    invalidate: ['cases.get', 'analysis.latest', 'jobs.list'],
  });
  const state = ANALYSIS_STATE_BADGES[detail.analysisState];

  const begin = async (force: boolean): Promise<void> => {
    try {
      const response = await start.mutateAsync({ params: { caseId: detail.id }, body: { force } });
      if (response.reused) {
        toast.info('The stored analysis was reused', {
          body: 'The input is identical, so nothing had to be re-run.',
        });
        refresh();
      } else {
        setStarted(response.job);
      }
    } catch (failure) {
      throw new Error(describeError(failure), { cause: failure });
    }
  };
  const startPlain = (): void => {
    begin(false).catch((failure: unknown) =>
      toast.error('The analysis could not be started', { body: describeError(failure) }),
    );
  };

  const analysed = run?.status === 'succeeded';
  return (
    <Panel
      title="Analysis"
      level={2}
      description="How CaseGuard analysed this case, and whether it is up to date."
      help="The analysis rebuilds the timeline, classifies every statement as evidence, weighs competing hypotheses, finds decision forks and scores quality. It is deterministic: identical input is never re-run, so repeating it returns the stored result. Re-running on purpose replaces the stored analysis; reviewer decisions are carried forward."
    >
      <div className={styles.head}>
        <StatusBadge status={state.status} label={state.label} />
        {run?.simulated ? <ProvenanceBadge kind="simulated" /> : null}
      </div>

      {activeJob ? (
        <JobProgress
          jobId={activeJob.id}
          title="Analysis in progress"
          level={3}
          onTerminal={(job) => {
            refresh();
            if (job.status === 'succeeded') toast.success('The analysis finished');
          }}
        />
      ) : null}

      {loading ? (
        <LoadingSkeleton variant="text" count={4} label="Loading the analysis" />
      ) : error ? (
        <ErrorState
          compact
          title="The analysis summary could not be loaded"
          description={describeError(error)}
          onRetry={onRetry}
        />
      ) : run ? (
        <>
          {run.status === 'failed' && run.error ? (
            <Notice variant="warning" title="The last analysis failed">
              {run.error}
            </Notice>
          ) : null}
          <KeyValueList
            columns={1}
            layout="inline"
            aria-label="Latest analysis"
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
              {
                id: 'started',
                label: 'Started',
                value: formatDateTimeUtc(run.startedAt),
              },
              {
                id: 'completed',
                label: 'Completed',
                value: run.completedAt ? formatDateTimeUtc(run.completedAt) : 'Not completed',
              },
              {
                id: 'hash',
                label: 'Input hash',
                value: (
                  <span>
                    <span className={styles.mono}>{run.inputHash.slice(0, 16)}…</span>{' '}
                    <CopyButton value={run.inputHash} label="Copy analysis input hash" />
                  </span>
                ),
                hint: 'Identical input is never re-run.',
              },
            ]}
          />
          {asOf === null ? (
            <dl className={styles.counts} aria-label="What the analysis produced">
              {COUNT_LABELS.map(([key, label]) => (
                <div key={key}>
                  <dt className={styles.countTerm}>{label}</dt>
                  <dd className={styles.countValue}>{formatNumber(run.counts[key])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={styles.text}>
              Totals for the whole record (forks, warnings, claims) are hidden while a time cursor
              is set.
            </p>
          )}
        </>
      ) : (
        <p className={styles.text} role={live ? 'status' : undefined}>
          {live
            ? 'An analysis is queued. This panel updates when it starts.'
            : 'This case has not been analysed yet. The timeline, evidence and hypotheses appear once it has been.'}
        </p>
      )}

      {!activeJob && !live ? (
        <div className={styles.actions}>
          {analysed ? (
            can('case:analyze') ? (
              <ConfirmDialog
                trigger={
                  <Button appearance="outline" icon={<ArrowSyncRegular />}>
                    Re-run the analysis
                  </Button>
                }
                title="Re-run the analysis?"
                confirmLabel="Re-run"
                onConfirm={() => begin(true)}
              >
                This replaces the stored analysis with a fresh run of the same case, even though the
                input has not changed. Reviewer decisions on claims and counterfactuals are carried
                forward where the result is unchanged.
              </ConfirmDialog>
            ) : (
              <GatedAction permission="case:analyze">
                <Button appearance="outline" icon={<ArrowSyncRegular />}>
                  Re-run the analysis
                </Button>
              </GatedAction>
            )
          ) : (
            <GatedAction permission="case:analyze">
              <Button
                appearance="primary"
                icon={start.isPending ? <Spinner size="tiny" /> : <PlayRegular />}
                disabled={start.isPending}
                onClick={startPlain}
              >
                {run?.status === 'failed' || detail.analysisState === 'failed'
                  ? 'Retry the analysis'
                  : 'Start the analysis'}
              </Button>
            </GatedAction>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
