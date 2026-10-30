'use client';

import type { Job, JobKind, JobStage, Permission } from '@caseguard/schemas';
import {
  ConfirmDialog,
  ErrorState,
  Notice,
  Panel,
  StatusBadge,
  VisuallyHidden,
  cg,
  formatTimeUtc,
  type BadgeStatus,
} from '@caseguard/ui';
import { Button, ProgressBar, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  CircleRegular,
  DismissCircleRegular,
  SubtractCircleRegular,
} from '@fluentui/react-icons';
import { describeError } from '../../lib/api/errors';
import { useApiMutation, useJob } from '../../lib/api/hooks';
import { GatedAction, useSession } from '../../lib/auth/session';

const useStyles = makeStyles({
  summary: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  stage: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    fontVariantNumeric: 'tabular-nums',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
  },
  icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '24px' },
  label: { color: cg.text, overflowWrap: 'anywhere' },
  detail: { display: 'block', color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  time: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  done: { color: cg.tone.productive.fg },
  failed: { color: cg.tone.unsupported.fg },
  muted: { color: cg.textMuted },
});

const JOB_STATUS: Record<Job['status'], { label: string; status: BadgeStatus }> = {
  queued: { label: 'Queued', status: 'neutral' },
  running: { label: 'Running', status: 'neutral' },
  succeeded: { label: 'Finished', status: 'productive' },
  failed: { label: 'Failed', status: 'unsupported' },
  cancelled: { label: 'Cancelled', status: 'missing' },
};

const STAGE_TEXT: Record<JobStage['status'], string> = {
  pending: 'Waiting',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** The permission the API requires to cancel each kind of job (the one that starts it). */
const CANCEL_PERMISSION: Record<JobKind, Permission> = {
  case_analysis: 'case:analyze',
  counterfactual: 'counterfactual:run',
  skill_extraction: 'skill:extract',
  skill_mutation: 'skill:mutate',
  demo_seed: 'demo:manage',
};

function StageIcon({ status }: { status: JobStage['status'] }) {
  const styles = useStyles();
  switch (status) {
    case 'running':
      return <Spinner size="extra-tiny" />;
    case 'done':
      return <CheckmarkCircleRegular className={styles.done} />;
    case 'failed':
      return <DismissCircleRegular className={styles.failed} />;
    case 'skipped':
      return <SubtractCircleRegular className={styles.muted} />;
    default:
      return <CircleRegular className={styles.muted} />;
  }
}

export interface JobProgressProps {
  jobId: string;
  /** What the job does, as the panel heading: "Analysing the case". */
  title: string;
  /** Called once when the job reaches a terminal state (finished, failed or cancelled). */
  onTerminal?: (job: Job) => void;
  /** Called after the API confirmed a cancellation. */
  onCancelled?: (job: Job) => void;
  /** Heading level of the panel title (default 2). */
  level?: 2 | 3;
}

/**
 * Live progress of a background job (`jobs.get`, polled until it is terminal): an overall bar, the real stages the API
 * reports with their status, a polite announcement of the current step, the failure reason, and a Cancel action for
 * jobs the API says can be cancelled. Cancelling asks for confirmation and shows the API's refusal (403, 409) in the
 * dialog.
 */
export function JobProgress({
  jobId,
  title,
  onTerminal,
  onCancelled,
  level = 2,
}: JobProgressProps) {
  const styles = useStyles();
  const { can } = useSession();
  const { job, percent, stage, stages, isTerminal, error, refetch } = useJob(jobId, {
    ...(onTerminal ? { onTerminal } : {}),
  });
  const cancel = useApiMutation('jobs.cancel', { invalidate: ['jobs.get', 'cases.get'] });

  if (!job) {
    return (
      <Panel title={title} level={level}>
        {error ? (
          <ErrorState
            compact
            title="The job status could not be read"
            description={describeError(error)}
            onRetry={() => void refetch()}
          />
        ) : (
          <p className={styles.stage} role="status">
            Waiting for the job to start…
          </p>
        )}
      </Panel>
    );
  }

  const meta = JOB_STATUS[job.status];
  const doneCount = stages.filter(
    (item) => item.status === 'done' || item.status === 'skipped',
  ).length;
  const current = stages.find((item) => item.status === 'running') ?? null;
  const announcement = isTerminal
    ? `${title}: ${meta.label.toLowerCase()}.`
    : `${title}: ${current ? current.label : stage}, ${doneCount} of ${stages.length} steps done.`;
  const permission = CANCEL_PERMISSION[job.kind];
  const cancelButton = <Button appearance="outline">Cancel</Button>;

  return (
    <Panel
      title={title}
      level={level}
      actions={
        job.cancellable && !isTerminal ? (
          can(permission) ? (
            <ConfirmDialog
              trigger={cancelButton}
              title="Cancel this job?"
              confirmLabel="Cancel the job"
              cancelLabel="Keep running"
              onConfirm={async () => {
                try {
                  const cancelled = await cancel.mutateAsync({ params: { jobId } });
                  onCancelled?.(cancelled);
                } catch (failure) {
                  throw new Error(describeError(failure), { cause: failure });
                }
              }}
            >
              Work already done is kept only if the job had saved it; the case itself stays. You can
              start the job again later.
            </ConfirmDialog>
          ) : (
            <GatedAction permission={permission}>{cancelButton}</GatedAction>
          )
        ) : null
      }
    >
      <div className={styles.summary}>
        <StatusBadge status={meta.status} label={meta.label} />
        <p className={styles.stage}>
          {isTerminal ? `${doneCount} of ${stages.length} steps done` : `${Math.round(percent)}%`}
          {!isTerminal && current ? ` · ${current.label}` : ''}
        </p>
      </div>
      <ProgressBar
        value={Math.min(1, Math.max(0, percent / 100))}
        max={1}
        aria-label={`${title}: ${Math.round(percent)} percent`}
        color={job.status === 'failed' ? 'error' : job.status === 'succeeded' ? 'success' : 'brand'}
      />
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      <ol className={styles.list} aria-label="Steps">
        {stages.map((item) => (
          <li key={item.id} className={styles.item}>
            <span className={styles.icon} aria-hidden="true">
              <StageIcon status={item.status} />
            </span>
            <span className={styles.label}>
              <VisuallyHidden>{STAGE_TEXT[item.status]}: </VisuallyHidden>
              {item.label}
              {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
            </span>
            <span className={styles.time}>
              {item.completedAt ? formatTimeUtc(item.completedAt, { seconds: true }) : ''}
            </span>
          </li>
        ))}
      </ol>
      {job.status === 'failed' && job.error ? (
        <Notice variant="warning" title="The job failed">
          {job.error.message} <span className={styles.time}>({job.error.code})</span>
        </Notice>
      ) : null}
      {job.status === 'cancelled' ? (
        <Notice variant="info" title="Cancelled">
          The job was cancelled before it finished. Nothing further will run.
        </Notice>
      ) : null}
    </Panel>
  );
}
