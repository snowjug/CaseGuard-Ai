'use client';

import type { IngestResult, IngestionPreview } from '@caseguard/schemas';
import { Notice, PageHeader, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
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
import { Stepper } from './Stepper';

const STEPS = [
  { id: 'source', label: 'Choose a source' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'create', label: 'Create and analyse' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const STEP_TITLES: Record<StepId, string> = {
  source: 'Choose a source',
  review: 'Review what will be created',
  confirm: 'Confirm and create',
  create: 'Create and analyse',
};

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  heading: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    outlineStyle: 'none',
  },
});

const CHOICE_CODEC = codecs.enumOf(SOURCE_CHOICES, 'sample');
const SAMPLE_CODEC = codecs.optionalString();

const PAGE_HELP = (
  <>
    <p>
      Bring a support case into CaseGuard in four steps. First you pick a source: a built-in
      synthetic sample, pasted text, an uploaded file or a JSON bundle. Then the same pipeline that
      stores cases checks it and shows you the result without saving anything: validation problems,
      what would be redacted, prompt-injection findings and a preview of the timeline.
    </p>
    <p>
      Only when you confirm is the case stored, as an immutable record, and its analysis started.
      Creating the same content twice never duplicates a case.
    </p>
  </>
);

function newAttemptKey(): string {
  return `cg-ingest-${crypto.randomUUID()}`;
}

/**
 * The ingestion wizard (`/cases/new`): choose a source, review the validation, redaction and injection preview, confirm,
 * create (idempotent) and follow the analysis job to the finished case. The chosen source is in the URL; every API
 * error is explained: 413, 415, 422 (invalid, unsafe, redaction incomplete, key reuse), the 409s (reference in use,
 * identical request still running, anything else) and 429 with its retry delay.
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

  const index = STEPS.findIndex((item) => item.id === step);
  return (
    <>
      <PageHeader
        title="Ingest a case"
        description="Bring a support case into CaseGuard: see how it will be read first, then confirm."
        help={PAGE_HELP}
      />
      <div className={styles.page}>
        {session && !can('case:ingest') ? (
          <Notice variant="warning" title="Your role cannot ingest cases">
            You can explore this page, but validating and creating a case needs the Engineer or
            Administrator role, so those buttons are disabled.
          </Notice>
        ) : null}
        <Stepper steps={STEPS} current={index} label="Ingestion steps" />
        <h2 ref={heading} tabIndex={-1} className={styles.heading}>
          {`Step ${index + 1} of ${STEPS.length}: ${STEP_TITLES[step]}`}
        </h2>
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
          <ProgressStep result={result} onAnotherCase={restart} />
        ) : null}
      </div>
    </>
  );
}
