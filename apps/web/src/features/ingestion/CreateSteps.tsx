'use client';

import type { IngestResult, IngestionPreview, Job } from '@caseguard/schemas';
import { KeyValueList, Notice, Panel, ProvenanceBadge, StatusBadge, cg } from '@caseguard/ui';
import { Button, Checkbox, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkCircleRegular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
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

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  done: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
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

/** Step 3: one last look, the analysis option, and the create button (idempotent: a repeat never duplicates the case). */
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
  return (
    <div className={styles.stack}>
      <Panel
        title="Create the case"
        level={3}
        description="This stores the case and, unless you switch it off, starts its analysis."
      >
        <KeyValueList
          columns={2}
          items={[
            {
              id: 'case',
              label: 'Case',
              value: summary ? `${summary.reference}: ${summary.title}` : 'Unknown',
            },
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
              label: 'Prompt-injection screening',
              value: preview.injection.detected
                ? `${countOf(preview.injection.findings.length, 'finding')}, highest severity ${preview.injection.highestSeverity}`
                : 'Nothing flagged',
            },
          ]}
        />
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
              ? 'The analysis rebuilds the timeline, classifies evidence and ranks hypotheses. It takes a few seconds and you can watch each step.'
              : 'The case will be stored without an analysis. You can start it later from the case page.'}
        </p>
        <Notice variant="info" compact title="Immutable record">
          The original events cannot be edited once the case exists. Creating the same content again
          returns the existing case instead of a copy.
        </Notice>
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
          <Button
            appearance="outline"
            icon={<ArrowLeftRegular />}
            disabled={pending}
            onClick={onBack}
          >
            Back to review
          </Button>
          <GatedAction permission="case:ingest">
            <Button
              appearance="primary"
              disabled={pending || !preview.ok}
              icon={pending ? <Spinner size="tiny" /> : undefined}
              onClick={onCreate}
            >
              {pending ? 'Creating…' : 'Create case'}
            </Button>
          </GatedAction>
        </div>
      </Panel>
    </div>
  );
}

export interface ProgressStepProps {
  result: IngestResult;
  onAnotherCase: () => void;
}

/**
 * Step 4: the case exists. Shows the real stages of its analysis job (cancellable), explains an idempotent replay or a
 * missing job honestly, and, when the analysis finishes, says so and puts the focus on "Open the case". Nothing
 * navigates by itself: a person who is still reading the result is never moved on (WCAG 2.2.1).
 */
export function ProgressStep({ result, onAnotherCase }: ProgressStepProps) {
  const styles = useStyles();
  const toast = useToast();
  const caseId = result.case.id;
  const [started, setStarted] = useState<Job | null>(null);
  const [outcome, setOutcome] = useState<Job['status'] | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const job = started ?? result.analysisJob;
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

  return (
    <div className={styles.stack}>
      <Panel
        title={result.created ? 'The case was created' : 'This case already exists'}
        level={3}
        description={`${result.case.reference}: ${result.case.title}`}
      >
        <div className={styles.done}>
          <CheckmarkCircleRegular aria-hidden="true" />
          <StatusBadge
            status="productive"
            label={result.created ? 'Stored as an immutable record' : 'Nothing new was stored'}
          />
          {result.case.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          <span className={styles.text}>{countOf(result.eventCount, 'event')}</span>
        </div>
        {!result.created ? (
          <Notice variant="info" title="Identical content">
            Identical content had been ingested before, so the existing case was returned instead of
            creating a copy.
          </Notice>
        ) : null}
        {result.preview.redaction.applied ? (
          <p className={styles.text}>
            {countOf(result.preview.redaction.totalReplacements, 'value')} redacted before storage.
          </p>
        ) : null}
      </Panel>

      {job ? (
        <JobProgress
          jobId={job.id}
          title="Analysing the case"
          level={3}
          onTerminal={(finished) => setOutcome(finished.status)}
        />
      ) : (
        <Panel title="The analysis has not started" level={3}>
          <p className={styles.text}>
            {result.created
              ? 'The case is stored, but no analysis is running. You chose not to start one, or the server could not start it. The case is not lost.'
              : 'No analysis was started for this request. The existing case keeps its current analysis.'}
          </p>
          <div className={styles.actions}>
            <GatedAction permission="case:analyze">
              <Button
                appearance="primary"
                disabled={start.isPending}
                icon={start.isPending ? <Spinner size="tiny" /> : undefined}
                onClick={() => void startAnalysis()}
              >
                {start.isPending ? 'Starting…' : 'Start the analysis'}
              </Button>
            </GatedAction>
          </div>
        </Panel>
      )}

      {outcome === 'succeeded' ? (
        <p className={styles.text} role="status">
          The analysis finished. The case is ready to open.
        </p>
      ) : null}
      {outcome === 'failed' || outcome === 'cancelled' ? (
        <Notice variant="warning" title="The analysis did not finish">
          The case is stored and can be opened. Start the analysis again from the case page.
          <div className={styles.actions}>
            <GatedAction permission="case:analyze">
              <Button
                appearance="outline"
                disabled={start.isPending}
                onClick={() => void startAnalysis()}
              >
                Start the analysis again
              </Button>
            </GatedAction>
          </div>
        </Notice>
      ) : null}

      <div className={styles.actions} ref={actionsRef}>
        <LinkButton href={caseHref(caseId)} appearance="primary">
          Open the case
        </LinkButton>
        <Button appearance="outline" onClick={onAnotherCase}>
          Ingest another case
        </Button>
      </div>
    </div>
  );
}
