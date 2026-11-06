'use client';

import type { IngestResult, IngestionPreview } from '@caseguard/schemas';
import { BlurFade, Notice, PageHeader, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import { useApiMutation, useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { useRetryCountdown } from '../../lib/use-retry-countdown';
import { codecs, useUrlChoiceState } from '../../lib/url-state';
import { ConfirmStep, ProgressStep } from './CreateSteps';
import { explainIngestError, type IngestProblem } from './ingest-errors';
import {
  EMPTY_DRAFT,
  SOURCE_CHOICES,
  buildSourceRequest,
  uploadForm,
  type SourceChoice,
  type SourceDraft,
} from './ingest-source';
import { ReviewStep } from './ReviewStep';
import { SourceStep } from './SourceStep';
import { StepHeading, Stepper } from './Stepper';

/** Four internal steps, three phases: the review and the confirmation are both part of "Check". */
const PHASES = [
  { id: 'add', label: 'Add' },
  { id: 'check', label: 'Check' },
  { id: 'create', label: 'Create' },
] as const;
type StepId = 'source' | 'review' | 'confirm' | 'create';
const PHASE_OF: Record<StepId, number> = { source: 0, review: 1, confirm: 1, create: 2 };

/** What the heading of each step says, which is where the focus goes when the step changes. The last step names itself. */
const STEP_TITLES: Record<Exclude<StepId, 'create'>, string> = {
  source: 'Add your case',
  review: 'Check what will be created',
  confirm: 'Create the case',
};

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    maxWidth: '960px',
  },
  step: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
});

const CHOICE_CODEC = codecs.enumOf(SOURCE_CHOICES, 'paste');
const SAMPLE_CODEC = codecs.optionalString();

const PAGE_HELP = (
  <>
    <p>
      Paste text, upload a file, or try a built-in sample. CaseGuard checks it first and shows what
      would be saved, including anything hidden for privacy, without saving anything.
    </p>
    <p>
      When you create the case, it is saved as a record that cannot be edited and its review starts.
      Adding the same content twice never makes a duplicate.
    </p>
  </>
);

function newAttemptKey(): string {
  return `cg-ingest-${crypto.randomUUID()}`;
}

/**
 * The "Add a case" wizard (`/cases/new`), four steps in three phases (Add, Check, Create): add the case from a paste, an
 * upload, a built-in sample or a JSON bundle; check the validation, redaction and injection preview (the review and the
 * confirmation are both "Check"); create it (idempotent) and follow the analysis job to the finished case. The chosen
 * source is in the URL (`?source=`, Paste by default); every API error is explained: 413, 415, 422 (invalid, unsafe,
 * redaction incomplete, key reuse), the 409s (reference in use, identical request still running, anything else) and 429
 * with its retry delay.
 */
export function NewCasePage() {
  const styles = useStyles();
  const auth = useAuth();
  const { can, session } = useSession();
  const toast = useToast();
  const ready = auth.status === 'ready';

  // A choice shows at once: the router reports a written URL a moment late, and a radio or tab that waits for it
  // springs back to the old choice right after the click (see `useUrlChoiceState`).
  const [choice, setChoice] = useUrlChoiceState('source', CHOICE_CODEC);
  const [sampleParam, setSampleParam] = useUrlChoiceState('sample', SAMPLE_CODEC);
  const [local, setLocal] = useState<Omit<SourceDraft, 'choice' | 'sampleId'>>({
    pasteText: EMPTY_DRAFT.pasteText,
    title: EMPTY_DRAFT.title,
    workload: EMPTY_DRAFT.workload,
    file: EMPTY_DRAFT.file,
    bundleText: EMPTY_DRAFT.bundleText,
  });
  const [step, setStep] = useState<StepId>('source');
  const [preview, setPreview] = useState<IngestionPreview | null>(null);
  const [problem, setProblem] = useState<IngestProblem | null>(null);
  const [analyze, setAnalyze] = useState(true);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [retryIn, setRetryIn] = useRetryCountdown();
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const firstRender = useRef(true);

  const samples = useApiQuery('samples.list', undefined, { enabled: ready });
  const examples = useApiQuery('examples.list', undefined, { enabled: ready });
  const previewJson = useApiMutation('ingestion.preview');
  const previewFile = useApiMutation('ingestion.previewFile');
  const createJson = useApiMutation('cases.create', {
    invalidate: ['cases.list', 'dashboard.commandCenter'],
  });
  const createFile = useApiMutation('cases.createFromFile', {
    invalidate: ['cases.list', 'dashboard.commandCenter'],
  });

  const sampleItems = samples.data?.items ?? [];
  const sampleId = sampleItems.some((item) => item.id === sampleParam)
    ? sampleParam
    : (sampleItems[0]?.id ?? null);
  const draft: SourceDraft = { ...local, choice, sampleId };
  const pending =
    previewJson.isPending || previewFile.isPending || createJson.isPending || createFile.isPending;

  // Move focus to the new step's heading so keyboard and screen-reader users start at the right place.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const fail = (error: unknown): void => {
    const explained = explainIngestError(error, choice);
    // A request key that the server saw with different content is spent: the next attempt must use a fresh one.
    if (explained.kind === 'key_reuse') attempt.current = null;
    setProblem(explained);
    setRetryIn(explained.retryAfterSeconds ?? 0);
  };

  const changeDraft = (patch: Partial<SourceDraft>): void => {
    const { choice: _choice, sampleId: _sampleId, ...rest } = patch;
    setLocal((current) => ({ ...current, ...rest }));
    setProblem(null);
  };
  const changeChoice = (next: SourceChoice): void => {
    setChoice(next);
    setProblem(null);
  };

  const validate = async (): Promise<void> => {
    const request = buildSourceRequest(draft);
    if (!request) return;
    setProblem(null);
    try {
      const checked =
        request.type === 'upload'
          ? await previewFile.mutateAsync({
              formData: uploadForm(request.file, request.workload),
            })
          : await previewJson.mutateAsync({ body: { source: request.source } });
      setPreview(checked);
      setStep('review');
    } catch (error) {
      fail(error);
    }
  };

  const create = async (): Promise<void> => {
    const request = buildSourceRequest(draft);
    if (!preview || !request) return;
    setProblem(null);
    // One key per attempt: repeating the same request (a double click, a manual retry) is safe, while a changed payload or
    // option gets a new key instead of colliding with the earlier one.
    const fingerprint = `${preview.contentHash}:${analyze ? 1 : 0}:${request.type}`;
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newAttemptKey() };
    }
    const idempotencyKey = attempt.current.key;
    try {
      const created =
        request.type === 'upload'
          ? await createFile.mutateAsync({
              formData: uploadForm(request.file, request.workload),
              idempotencyKey,
            })
          : await createJson.mutateAsync({
              body: { source: request.source, options: { analyze } },
              idempotencyKey,
            });
      setResult(created);
      setStep('create');
      toast.success(
        created.created
          ? `Created ${created.case.reference}`
          : `${created.case.reference} already exists`,
      );
    } catch (error) {
      fail(error);
    }
  };

  const restart = (): void => {
    setStep('source');
    setPreview(null);
    setResult(null);
    setProblem(null);
    setRetryIn(0);
    attempt.current = null;
    setLocal({
      pasteText: '',
      title: '',
      workload: '',
      file: null,
      bundleText: '',
    });
    setAnalyze(true);
  };

  return (
    <>
      <PageHeader
        title="Add a case"
        description="Paste, upload or try a sample, then get the review."
        help={PAGE_HELP}
      />
      <div className={styles.page}>
        {session && !can('case:ingest') ? (
          <Notice variant="warning" compact title="Your role cannot add cases">
            You can look around, but checking and creating a case needs the Engineer or
            Administrator role.
          </Notice>
        ) : null}
        <BlurFade index={0}>
          <Stepper steps={PHASES} current={PHASE_OF[step]} label="Progress" />
        </BlurFade>
        <div className={styles.step}>
          {step === 'create' ? null : <StepHeading ref={heading}>{STEP_TITLES[step]}</StepHeading>}
          {step === 'source' ? (
            <SourceStep
              draft={draft}
              onDraftChange={changeDraft}
              onChoiceChange={changeChoice}
              onSampleChange={(id) => {
                setSampleParam(id);
                setProblem(null);
              }}
              samples={samples}
              examples={examples}
              onSubmit={() => void validate()}
              pending={pending}
              problem={problem}
              retryIn={retryIn}
            />
          ) : null}
          {step === 'review' && preview ? (
            <ReviewStep
              preview={preview}
              source={choice}
              onBack={() => setStep('source')}
              onContinue={() => {
                setProblem(null);
                setStep('confirm');
              }}
            />
          ) : null}
          {step === 'confirm' && preview ? (
            <ConfirmStep
              preview={preview}
              choice={choice}
              analyze={analyze}
              onAnalyzeChange={setAnalyze}
              onBack={() => {
                setProblem(null);
                setStep('review');
              }}
              onCreate={() => void create()}
              pending={pending}
              problem={problem}
              retryIn={retryIn}
            />
          ) : null}
          {step === 'create' && result ? (
            <ProgressStep result={result} onAnotherCase={restart} headingRef={heading} />
          ) : null}
        </div>
      </div>
    </>
  );
}
