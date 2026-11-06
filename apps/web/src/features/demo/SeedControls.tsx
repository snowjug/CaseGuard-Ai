'use client';

import { Button, ConfirmDialog, HelpButton, cg } from '@caseguard/ui';
import { ProgressBar, makeStyles, tokens } from '@fluentui/react-components';
import { DatabaseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useApiMutation, useApiQuery } from '../../lib/api/hooks';
import { invalidateAll } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { explainDemoError } from '../../lib/presentation/demo-errors';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  intro: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  introText: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  rows: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: `${cg.space[3]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0 },
    '@media (min-width: 640px)': {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: cg.space[6],
    },
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    maxWidth: '64ch',
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  description: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
  action: { flexShrink: 0 },
  progress: { display: 'flex', flexDirection: 'column', gap: cg.space[1], marginTop: cg.space[3] },
  dialogText: { margin: 0 },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

/** Explains a refusal by the API's stable reason (not a synthetic demo tenant, a job is running, personas missing). */
const explain = explainDemoError;

const HELP =
  'Seeding plays the story through the real services as the synthetic personas, so permissions, four-eyes approval and the audit trail apply exactly as they do over HTTP. Progress on this page is derived from what is stored, so it moves only when the data does. The API refuses these actions outside a synthetic demo tenant.';

interface ControlProps {
  title: string;
  description: ReactNode;
  allowed: boolean;
  button: ReactElement<{ disabledFocusable?: boolean; onClick?: unknown }>;
  dialogTitle: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  onConfirm: () => Promise<void>;
  children: ReactNode;
}

/** One control: a button that opens a confirmation, or the same button disabled with the reason when not permitted. */
function Control({
  title,
  description,
  allowed,
  button,
  dialogTitle,
  confirmLabel,
  tone = 'default',
  onConfirm,
  children,
}: ControlProps) {
  const styles = useStyles();
  return (
    <div className={styles.row} role="group" aria-label={title}>
      <div className={styles.text}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>
      </div>
      <div className={styles.action}>
        {allowed ? (
          <ConfirmDialog
            title={dialogTitle}
            confirmLabel={confirmLabel}
            tone={tone}
            trigger={button}
            onConfirm={onConfirm}
          >
            {children}
          </ConfirmDialog>
        ) : (
          <GatedAction permission="demo:manage">{button}</GatedAction>
        )}
      </div>
    </div>
  );
}

/**
 * Seed and reset controls for the synthetic demo tenant (administrator only). Each action is confirmed, runs through
 * the real services, and refreshes everything on screen afterwards. The API refuses (409) anywhere but a synthetic demo
 * tenant, while a job runs, or when the demo personas are missing; the dialog explains the refusal by its `reason`.
 */
export function SeedControls() {
  const styles = useStyles();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const allowed = can('demo:manage');
  const seed = useApiMutation('demo.seed');
  const reset = useApiMutation('demo.reset');
  const busy = seed.isPending || reset.isPending;
  const running = useApiQuery(
    'jobs.list',
    { query: { kind: 'demo_seed', status: 'running', limit: 1 } },
    { enabled: seed.isPending && auth.status === 'ready', refetchInterval: 1500, staleTime: 0 },
  );
  const job = running.data?.items[0];

  const runSeed = (profile: 'base' | 'portfolio', done: string) => async (): Promise<void> => {
    try {
      await seed.mutateAsync({ body: { profile } });
    } catch (error) {
      throw explain(error);
    }
    await invalidateAll(queryClient, auth.identityKey);
    toast.success(done);
  };

  const runReset = async (): Promise<void> => {
    try {
      await reset.mutateAsync({});
    } catch (error) {
      throw explain(error);
    }
    await invalidateAll(queryClient, auth.identityKey);
    toast.success('Demo data reset');
  };

  const doneStages = job?.progress.stages.filter((stage) => stage.status === 'done').length ?? 0;
  // Shown inside the confirmation dialog, which stays open (and covers the page) while the story is being played.
  const progress = seed.isPending ? (
    <div className={styles.progress} role="status" aria-live="polite">
      <p className={styles.note}>
        {job
          ? `Playing the story: ${job.progress.stage || 'starting'} (${doneStages} of ${job.progress.stages.length} stages done)`
          : 'Playing the story: starting…'}
      </p>
      <ProgressBar
        thickness="medium"
        {...(job ? { value: job.progress.percent, max: 100 } : {})}
        aria-label="Seeding progress"
      />
    </div>
  ) : null;

  return (
    <div className={styles.stack} aria-busy={busy}>
      <div className={styles.intro}>
        <p className={styles.introText}>
          Seed or reset the synthetic story in this tenant. Administrators only.
        </p>
        <HelpButton label="About seeding and resetting" title="Seed and reset">
          {HELP}
        </HelpButton>
      </div>
      <div className={styles.rows}>
        <Control
          title="Play the whole story"
          description="Imports both cases, analyses them, accepts the better path, walks the skill through governed approval and applies it to Case Two. Steps already done are skipped, so it is safe to repeat."
          allowed={allowed}
          button={
            <Button variant="secondary" icon={<PlayIcon />} disabled={busy}>
              Play the whole story
            </Button>
          }
          dialogTitle="Play the whole story?"
          confirmLabel="Play the story"
          onConfirm={runSeed('portfolio', 'The demo story was played')}
        >
          <p className={styles.dialogText}>
            This runs all 13 steps as the synthetic personas. On a slow machine it can take a
            minute. Nothing outside the synthetic demo tenant is touched.
          </p>
          {progress}
        </Control>
        <Control
          title="Start from step 1"
          description="Erases case data and leaves the story at step 1, ready for a live walk-through. Users, settings and the audit trail stay."
          allowed={allowed}
          button={
            <Button variant="secondary" icon={<DatabaseIcon />} disabled={busy}>
              Start from step 1
            </Button>
          }
          dialogTitle="Erase case data and start from step 1?"
          confirmLabel="Erase and start over"
          tone="danger"
          onConfirm={runSeed('base', 'Demo data reset to step 1')}
        >
          <p className={styles.dialogText}>
            All cases, analysis results, skills and jobs in this synthetic tenant are erased. Users,
            settings and the audit trail are kept.
          </p>
          {progress}
        </Control>
        <Control
          title="Reset demo data"
          description="Erases case data and clears demo progress, so every step is incomplete again."
          allowed={allowed}
          button={
            <Button variant="secondary" icon={<RotateCcwIcon />} disabled={busy}>
              Reset demo data
            </Button>
          }
          dialogTitle="Reset the demo data?"
          confirmLabel="Reset demo"
          tone="danger"
          onConfirm={runReset}
        >
          This erases the cases, analysis results, skills and jobs of this synthetic tenant and
          clears demo progress. It cannot be undone; the audit trail records that it happened.
        </Control>
      </div>
    </div>
  );
}
