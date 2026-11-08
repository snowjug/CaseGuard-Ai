'use client';

import type { IngestResult, IngestionPreview, Job } from '@caseguard/schemas';
import {
  Badge,
  BlurFade,
  Button,
  Card,
  KeyValueList,
  Notice,
  ProvenanceBadge,
  cg,
} from '@caseguard/ui';
import { Checkbox, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type Ref } from 'react';
import { countOf } from '../../components/case/labels';
import { JobProgress } from '../../components/common/JobProgress';
import { LinkButton } from '../../components/common/LinkButton';
import { describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction } from '../../lib/auth/session';
import { caseHref } from '../../lib/deep-links';
import { useToast } from '../../lib/toast';
import type { IngestProblem } from './ingest-errors';
import type { SourceChoice } from './ingest-source';
import { ProblemView } from './ProblemView';
import { StepHeading } from './Stepper';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  card: {
    gap: cg.space[6],
    '@media (max-width: 639px)': { padding: cg.space[4], gap: cg.space[4] },
  },
  head: { gap: cg.space[4], '@media (max-width: 639px)': { padding: cg.space[4] } },
  ready: {
    alignItems: 'center',
    textAlign: 'center',
    '@media (max-width: 639px)': { padding: cg.space[6] },
  },
  check: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '72px',
    height: '72px',
    borderRadius: cg.radius.pill,
    fontSize: '36px',
    color: cg.tone.productive.fg,
    backgroundColor: cg.tone.productive.tint,
    boxShadow: `0 0 0 8px color-mix(in srgb, ${cg.tone.productive.solid} 14%, transparent), 0 16px 48px -12px color-mix(in srgb, ${cg.tone.productive.solid} 55%, transparent)`,
  },
  caseLine: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'inherit',
    gap: cg.space[1],
    minWidth: 0,
  },
  ref: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.tone.brand.fg,
    overflowWrap: 'anywhere',
  },
  caseTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    marginTop: cg.space[2],
  },
  metaCentered: { justifyContent: 'center' },
  option: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  small: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  smallIcon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg, fontSize: '16px' },
  sectionTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  links: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  linksCentered: { justifyContent: 'center' },
  noticeActions: { marginTop: cg.space[2] },
});

export interface ConfirmStepProps {
  preview: IngestionPreview;
  choice: SourceChoice;
  analyze: boolean;
  onAnalyzeChange: (analyze: boolean) => void;
  onBack: () => void;
  onCreate: () => void;
  pending: boolean;
  problem: IngestProblem | null;
  retryIn: number;
}

/**
 * Step 3, "Create the case": one last look, the analysis option, and the one primary button (idempotent: a repeat never
 * duplicates the case). The button says "Create and analyse" while an analysis will start, "Create case" when it will not.
 */
export function ConfirmStep({
  preview,
  choice,
  analyze,
  onAnalyzeChange,
  onBack,
  onCreate,
  pending,
  problem,
  retryIn,
}: ConfirmStepProps) {
  const styles = useStyles();
  const summary = preview.summary;
  const locked = choice === 'file';
  const analysing = locked || analyze;
  return (
    <BlurFade index={0}>
      <Card glow padding="md" className={styles.card}>
        <div className={styles.caseLine}>
          <span className={styles.ref}>{summary ? summary.reference : 'Unknown case'}</span>
          {summary ? <p className={styles.caseTitle}>{summary.title}</p> : null}
        </div>
        <KeyValueList
          columns={3}
          items={[
            {
              id: 'content',
              label: 'Content',
              value: summary
                ? `${countOf(summary.eventCount, 'event')} from ${countOf(summary.participantCount, 'participant')}`
                : 'Unknown',
            },
            {
              id: 'redaction',
              label: 'Redaction',
              value: preview.redaction.applied
                ? `${countOf(preview.redaction.totalReplacements, 'value')} replaced`
                : 'Nothing replaced',
            },
            {
              id: 'injection',
              label: 'Injection screening',
              value: preview.injection.detected
                ? `${countOf(preview.injection.findings.length, 'finding')}, highest severity ${preview.injection.highestSeverity}`
                : 'Nothing flagged',
            },
          ]}
        />
        <div className={styles.option}>
          <Checkbox
            checked={locked ? true : analyze}
            disabled={locked || pending}
            label="Start the analysis as soon as the case is created"
            onChange={(_event, data) => onAnalyzeChange(data.checked === true)}
          />
          <p className={styles.text}>
            {locked
              ? 'Uploaded files are always analysed on creation.'
              : analyze
                ? 'The analysis takes a few seconds and you can watch each step.'
                : 'The case will be stored without an analysis. You can start it later from the case page.'}
          </p>
        </div>
        <p className={styles.small}>
          <span aria-hidden="true" className={styles.smallIcon}>
            <LockIcon />
          </span>
          Creating the same content again returns the existing case instead of a copy.
        </p>
        {problem ? (
          <ProblemView
            problem={problem}
            retryIn={retryIn}
            onRetry={onCreate}
            retrying={pending}
            retryLabel="Try again"
          />
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" icon={<ArrowLeftIcon />} disabled={pending} onClick={onBack}>
            Back
          </Button>
          <GatedAction permission="case:ingest">
            <Button
              variant="primary"
              size="lg"
              disabled={!preview.ok}
              loading={pending}
              onClick={onCreate}
            >
              {pending ? 'Creating…' : analysing ? 'Create and analyse' : 'Create case'}
            </Button>
          </GatedAction>
        </div>
      </Card>
    </BlurFade>
  );
}

export interface ProgressStepProps {
  result: IngestResult;
  onAnotherCase: () => void;
  /** Focus moves to the step's heading when the step opens, so keyboard and screen-reader users start at the right place. */
  headingRef: Ref<HTMLHeadingElement>;
}

/**
 * Step 4: the case exists. Shows the real stages of its analysis job (cancellable), explains an idempotent replay or a
 * missing job honestly, and, when the analysis finishes, replaces the progress with the success view and puts the focus
 * on its one primary action: "Open review" once there is an analysis to review, "Open the case" until then. Nothing
 * navigates by itself: a person who is still reading the result is never moved on (WCAG 2.2.1).
 */
export function ProgressStep({ result, onAnotherCase, headingRef }: ProgressStepProps) {
  const styles = useStyles();
  const toast = useToast();
  const caseId = result.case.id;
  const [started, setStarted] = useState<Job | null>(null);
  const [outcome, setOutcome] = useState<Job['status'] | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const job = started ?? result.analysisJob;
  // The review reads a finished analysis: one that has just ended, or one that an identical, already analysed case has.
  const reviewReady = outcome === 'succeeded' || (!job && result.case.analysisState === 'analyzed');
  const failed = outcome === 'failed' || outcome === 'cancelled';
  const start = useApiMutation('analysis.start', {
    invalidate: ['cases.list', 'cases.get', 'analysis.latest'],
  });

  useEffect(() => {
    if (outcome === 'succeeded') actionsRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
  }, [outcome]);

  const startAnalysis = async (): Promise<void> => {
    try {
      const response = await start.mutateAsync({ params: { caseId }, body: {} });
      setOutcome(null);
      setStarted(response.job);
    } catch (error) {
      toast.error('The analysis could not be started', { body: describeError(error) });
    }
  };

  const title = !result.created
    ? 'This case already exists'
    : reviewReady
      ? 'Your case is ready'
      : failed || !job
        ? 'Your case is saved'
        : 'Creating your case';

  const actions = (
    <div
      className={mergeClasses(styles.links, reviewReady && styles.linksCentered)}
      ref={actionsRef}
    >
      {reviewReady ? (
        <>
          <LinkButton
            href={caseHref(caseId, 'review')}
            appearance="primary"
            size="large"
            icon={<ArrowRightIcon />}
            iconPosition="after"
          >
            Open review
          </LinkButton>
          <LinkButton href={caseHref(caseId)} appearance="outline">
            Open the case
          </LinkButton>
        </>
      ) : (
        <LinkButton href={caseHref(caseId)} appearance={failed ? 'primary' : 'outline'}>
          Open the case
        </LinkButton>
      )}
      <Button variant="ghost" icon={<PlusIcon />} onClick={onAnotherCase}>
        Add another case
      </Button>
    </div>
  );

  return (
    <div className={styles.stack}>
      <BlurFade index={0}>
        <Card
          glow={reviewReady}
          hero={reviewReady}
          padding={reviewReady ? 'lg' : 'md'}
          className={mergeClasses(styles.head, reviewReady && styles.ready)}
        >
          {reviewReady ? (
            <span aria-hidden="true" className={styles.check}>
              <CheckIcon />
            </span>
          ) : null}
          <StepHeading ref={headingRef}>{title}</StepHeading>
          <div className={styles.caseLine}>
            <span className={styles.ref}>{result.case.reference}</span>
            <p className={styles.caseTitle}>{result.case.title}</p>
            <div className={mergeClasses(styles.meta, reviewReady && styles.metaCentered)}>
              {result.created ? (
                <Badge
                  tone="productive"
                  size="sm"
                  icon={<CheckIcon />}
                  title="Stored as an immutable record: its events cannot be edited"
                >
                  Saved
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm" icon={<InfoIcon />}>
                  Nothing new was saved
                </Badge>
              )}
              {result.case.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
              <span className={styles.small}>{countOf(result.eventCount, 'event')}</span>
            </div>
          </div>
          {!result.created ? (
            <Notice variant="info" compact title="Identical content">
              Identical content had been added before, so the existing case was returned instead of
              creating a copy.
            </Notice>
          ) : null}
          {result.preview.redaction.applied ? (
            <p className={styles.text}>
              {countOf(result.preview.redaction.totalReplacements, 'value')} redacted before
              storage.
            </p>
          ) : null}
          {outcome === 'succeeded' ? (
            <p className={styles.text} role="status">
              The analysis finished. The review is ready to open.
            </p>
          ) : null}
          {reviewReady ? actions : null}
        </Card>
      </BlurFade>

      {job && !reviewReady ? (
        <BlurFade index={1}>
          <JobProgress
            jobId={job.id}
            title="Analysing the case"
            level={3}
            onTerminal={(finished) => setOutcome(finished.status)}
          />
        </BlurFade>
      ) : null}
      {!job && !reviewReady ? (
        <BlurFade index={1}>
          <Card padding="md" className={styles.head}>
            <h3 className={styles.sectionTitle}>The analysis has not started</h3>
            <p className={styles.text}>
              {result.created
                ? 'The case is stored, but no analysis is running. You chose not to start one, or the server could not start it. The case is not lost.'
                : 'No analysis was started for this request. The existing case keeps its current analysis.'}
            </p>
            <div className={styles.links}>
              <GatedAction permission="case:analyze">
                <Button
                  variant="primary"
                  loading={start.isPending}
                  onClick={() => void startAnalysis()}
                >
                  {start.isPending ? 'Starting…' : 'Start the analysis'}
                </Button>
              </GatedAction>
            </div>
          </Card>
        </BlurFade>
      ) : null}
      {failed ? (
        <Notice variant="warning" title="The analysis did not finish">
          The case is stored and can be opened. Start the analysis again from the case page.
          <div className={styles.noticeActions}>
            <GatedAction permission="case:analyze">
              <Button
                variant="secondary"
                loading={start.isPending}
                onClick={() => void startAnalysis()}
              >
                Start the analysis again
              </Button>
            </GatedAction>
          </div>
        </Notice>
      ) : null}
      {reviewReady ? null : actions}
    </div>
  );
}
