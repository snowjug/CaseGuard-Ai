'use client';

import type { ExampleInfo, SampleBundleInfo } from '@caseguard/schemas';
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  cg,
} from '@caseguard/ui';
import {
  Button,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Tab,
  TabList,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownloadRegular,
  ArrowUploadRegular,
  ClipboardPasteRegular,
  CodeRegular,
  FolderOpenRegular,
} from '@fluentui/react-icons';
import { useId, useState, type ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { describeError, type ApiError } from '../../lib/api/errors';
import { useApiClient } from '../../lib/api/provider';
import { GatedAction } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import type { IngestProblem } from './ingest-errors';
import {
  ACCEPTED_EXTENSIONS,
  DEFAULT_UPLOAD_LIMIT_BYTES,
  PASTE_MAX_CHARS,
  SOURCE_CHOICES,
  SOURCE_CHOICE_LABELS,
  TITLE_MAX,
  WORKLOAD_MAX,
  draftProblems,
  extensionOf,
  fileNeedsWorkload,
  formatBytes,
  type SourceChoice,
  type SourceDraft,
} from './ingest-source';
import { ProblemView } from './ProblemView';
import { useDownload } from './use-download';

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  // Four tabs are wider than a phone: the strip scrolls inside its panel instead of widening the page.
  tabs: { maxWidth: '100%', overflowX: 'auto' },
  panel: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  samples: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  radios: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  sample: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
  },
  sampleSelected: {
    borderTopColor: cg.tone.brand.border,
    borderRightColor: cg.tone.brand.border,
    borderBottomColor: cg.tone.brand.border,
    borderLeftColor: cg.tone.brand.border,
    boxShadow: `inset 0 0 0 1px ${cg.tone.brand.border}`,
    backgroundColor: cg.tone.brand.tint,
  },
  sampleMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  hint: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  small: { margin: 0, color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
  textarea: { width: '100%', minHeight: '240px' },
  bundle: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  fields: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  drop: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
  },
  fileInput: {
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    maxWidth: '100%',
    '::file-selector-button': {
      minHeight: '32px',
      marginRight: cg.space[3],
      padding: `0 ${cg.space[3]}`,
      borderRadius: cg.radius.md,
      border: `1px solid ${cg.borderControl}`,
      backgroundColor: cg.surface,
      color: cg.text,
      fontSize: tokens.fontSizeBase300,
      cursor: 'pointer',
    },
  },
  downloads: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  download: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: cg.space[3],
    alignItems: 'center',
    padding: cg.space[2],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
});

const TAB_ICONS: Record<SourceChoice, ReactElement> = {
  sample: <FolderOpenRegular />,
  paste: <ClipboardPasteRegular />,
  file: <ArrowUploadRegular />,
  bundle: <CodeRegular />,
};

export interface SourceStepProps {
  draft: SourceDraft;
  onDraftChange: (patch: Partial<SourceDraft>) => void;
  onChoiceChange: (choice: SourceChoice) => void;
  onSampleChange: (sampleId: string) => void;
  samples: UseQueryResult<{ items: SampleBundleInfo[] }, ApiError>;
  examples: UseQueryResult<{ items: ExampleInfo[] }, ApiError>;
  onSubmit: () => void;
  pending: boolean;
  problem: IngestProblem | null;
  retryIn: number;
}

function SamplePanel({
  draft,
  samples,
  onSampleChange,
}: Pick<SourceStepProps, 'draft' | 'samples' | 'onSampleChange'>) {
  const styles = useStyles();
  if (samples.isPending)
    return <LoadingSkeleton variant="list" count={2} label="Loading samples" />;
  if (samples.isError) {
    return (
      <ErrorState
        compact
        title="The samples could not be loaded"
        description={describeError(samples.error)}
        onRetry={() => void samples.refetch()}
      />
    );
  }
  const items = samples.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        headingLevel={3}
        title="No built-in samples are available"
        description="Paste text, upload a file or provide a JSON bundle instead."
      />
    );
  }
  return (
    <div className={styles.samples}>
      <p className={styles.hint}>
        Built-in cases are synthetic: every person, organisation and incident in them is fictional.
        Loading one runs exactly the same pipeline as your own data.
      </p>
      <RadioGroup
        className={styles.radios}
        aria-label="Built-in sample"
        value={draft.sampleId ?? ''}
        onChange={(_event, data) => onSampleChange(data.value)}
      >
        {items.map((sample) => {
          const selected = draft.sampleId === sample.id;
          const descriptionId = `sample-${sample.id}-description`;
          return (
            <div
              key={sample.id}
              className={`${styles.sample} ${selected ? styles.sampleSelected : ''}`}
            >
              <Radio
                value={sample.id}
                label={`${sample.reference}: ${sample.title}`}
                aria-describedby={descriptionId}
              />
              <div className={styles.sampleMeta} id={descriptionId}>
                <ProvenanceBadge kind="synthetic" />
                <span className={styles.small}>
                  {sample.workload} · {sample.eventCount} events ·{' '}
                  {sample.role === 'primary' ? 'first case of the story' : 'follow-up case'}
                </span>
              </div>
              <p className={styles.hint}>{sample.description}</p>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

/** The workloads the built-in samples cover. Each has a knowledge pack, so these are the ones a case can state. */
function supportedWorkloads(samples: SourceStepProps['samples']): string[] {
  return [...new Set((samples.data?.items ?? []).map((sample) => sample.workload))].sort();
}

function PastePanel({
  draft,
  onDraftChange,
  examples,
  samples,
}: Pick<SourceStepProps, 'draft' | 'onDraftChange' | 'examples' | 'samples'>) {
  const styles = useStyles();
  const problems = draftProblems(draft);
  const titleProblem = problems.find((problem) => problem.field === 'title');
  const workloadProblem = problems.find((problem) => problem.field === 'workload');
  const workloads = supportedWorkloads(samples);
  const supported = workloads.length > 0 ? ` Supported: ${workloads.join(', ')}.` : '';
  const transcripts = (examples.data?.items ?? []).filter(
    (example) => example.kind === 'transcript' && example.pasteText,
  );
  const length = draft.pasteText.length;
  return (
    <div className={styles.panel}>
      <p className={styles.hint}>
        Paste an email thread, call notes or a support transcript. Use fictional data only: values
        that look like secrets or personal data (keys, tokens, email addresses, IP addresses, phone
        numbers) are redacted before anything is stored, and you see what was redacted before you
        confirm.
      </p>
      <p className={styles.small}>
        Lines that carry only a time are dated from the day you paste, so the same text pasted on
        another day becomes a new case. Text with full dates always gives the same case: pasting it
        again returns the case that already exists instead of a copy.
      </p>
      <Field
        label="Case text"
        required
        hint={`${length.toLocaleString('en-US')} of ${PASTE_MAX_CHARS.toLocaleString('en-US')} characters`}
        validationState={length > PASTE_MAX_CHARS ? 'error' : 'none'}
        validationMessage={
          length > PASTE_MAX_CHARS ? 'This is longer than the API accepts.' : undefined
        }
      >
        <Textarea
          className={styles.textarea}
          resize="vertical"
          rows={12}
          value={draft.pasteText}
          onChange={(_event, data) => onDraftChange({ pasteText: data.value })}
        />
      </Field>
      {transcripts.length > 0 ? (
        <div className={styles.row}>
          {transcripts.map((example) => (
            <Button
              key={example.id}
              appearance="outline"
              onClick={() => onDraftChange({ pasteText: example.pasteText ?? '' })}
            >
              Insert example: {example.title}
            </Button>
          ))}
        </div>
      ) : null}
      <div className={styles.fields}>
        <Field
          label="Title (optional)"
          hint="Leave empty to let CaseGuard derive one."
          validationState={titleProblem ? 'error' : 'none'}
          validationMessage={titleProblem?.message}
        >
          <Input
            value={draft.title}
            maxLength={TITLE_MAX + 20}
            onChange={(_event, data) => onDraftChange({ title: data.value })}
          />
        </Field>
        <Field
          label="Workload"
          hint={`Required unless a "Workload:" line comes before the first message.${supported}`}
          validationState={workloadProblem ? 'error' : 'none'}
          validationMessage={workloadProblem?.message}
        >
          <Input
            value={draft.workload}
            maxLength={WORKLOAD_MAX + 20}
            onChange={(_event, data) => onDraftChange({ workload: data.value })}
          />
        </Field>
      </div>
    </div>
  );
}

function FilePanel({
  draft,
  onDraftChange,
  samples,
}: Pick<SourceStepProps, 'draft' | 'onDraftChange' | 'samples'>) {
  const styles = useStyles();
  const inputId = useId();
  const file = draft.file;
  const problems = draftProblems(draft);
  const problem = problems.find((item) => item.field === 'file');
  const workloadProblem = problems.find((item) => item.field === 'workload');
  const needsWorkload = fileNeedsWorkload(file);
  const workloads = supportedWorkloads(samples);
  const workloadHint =
    file === null
      ? 'Choose the workload the file belongs to. A JSON bundle states its own.'
      : needsWorkload
        ? `A ${extensionOf(file.name)} file does not say which workload it belongs to, and CaseGuard does not guess.`
        : 'This JSON bundle states its own workload, so nothing is needed here.';
  return (
    <div className={styles.panel}>
      <p className={styles.hint}>
        Upload a {ACCEPTED_EXTENSIONS.join(', ')} file: a JSON case bundle, a CSV of events or a
        plain-text transcript. The server checks the file by its content, not its name, and refuses
        executables, binaries and files that are too large (2 MB by default).
      </p>
      <div className={styles.drop}>
        <label htmlFor={inputId}>
          <strong>Choose a file</strong>
        </label>
        <input
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          aria-describedby={`${inputId}-hint`}
          onChange={(event) => onDraftChange({ file: event.target.files?.[0] ?? null })}
        />
        <p id={`${inputId}-hint`} className={styles.small}>
          {file
            ? `${file.name} · ${formatBytes(file.size)}${
                file.size > DEFAULT_UPLOAD_LIMIT_BYTES
                  ? ' · larger than the default 2 MB limit; the server may refuse it'
                  : ''
              }`
            : 'No file chosen.'}
        </p>
        {file && problem ? (
          <p role="alert" className={styles.small}>
            {problem.message} Found {extensionOf(file.name) || 'no extension'}.
          </p>
        ) : null}
      </div>
      <Field
        label="Workload"
        required={needsWorkload}
        hint={workloadHint}
        validationState={needsWorkload && workloadProblem ? 'error' : 'none'}
        validationMessage={needsWorkload ? workloadProblem?.message : undefined}
      >
        {workloads.length > 0 ? (
          <Select
            value={draft.workload}
            disabled={file !== null && !needsWorkload}
            onChange={(_event, data) => onDraftChange({ workload: data.value })}
          >
            <option value="">Choose a workload…</option>
            {workloads.map((workload) => (
              <option key={workload} value={workload}>
                {workload}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={draft.workload}
            disabled={file !== null && !needsWorkload}
            maxLength={WORKLOAD_MAX + 20}
            onChange={(_event, data) => onDraftChange({ workload: data.value })}
          />
        )}
      </Field>
      <Notice variant="info" compact title={null}>
        An uploaded file is analysed as soon as it is created; unlike pasted text or a bundle you
        cannot defer the analysis.
      </Notice>
    </div>
  );
}

function BundlePanel({
  draft,
  onDraftChange,
  examples,
}: Pick<SourceStepProps, 'draft' | 'onDraftChange' | 'examples'>) {
  const styles = useStyles();
  const client = useApiClient();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const inputId = useId();
  const problem = draftProblems(draft).find((item) => item.field === 'bundleText');
  const touched = draft.bundleText.trim() !== '';
  const bundles = (examples.data?.items ?? []).filter((example) => example.kind === 'case_bundle');

  const loadExample = async (example: ExampleInfo): Promise<void> => {
    setLoading(true);
    try {
      const bundle = await client.call('examples.get', { params: { exampleId: example.id } });
      onDraftChange({ bundleText: JSON.stringify(bundle, null, 2) });
    } catch (error) {
      toast.error('The example could not be loaded', { body: describeError(error) });
    } finally {
      setLoading(false);
    }
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      onDraftChange({ bundleText: await file.text() });
    } catch (error) {
      toast.error('The file could not be read', { body: describeError(error) });
    }
  };

  return (
    <div className={styles.panel}>
      <p className={styles.hint}>
        Provide a case bundle in the CaseGuard JSON format (see the schema on the right). Every
        field is validated and errors are listed with their path. The bundle must declare{' '}
        <code className={styles.mono}>&quot;synthetic&quot;: true</code> unless this workspace
        accepts real data.
      </p>
      <Field
        label="Case bundle (JSON)"
        required
        validationState={touched && problem ? 'error' : 'none'}
        validationMessage={touched ? problem?.message : undefined}
      >
        <Textarea
          className={styles.textarea}
          textarea={{ className: styles.bundle, spellCheck: false }}
          resize="vertical"
          rows={14}
          value={draft.bundleText}
          onChange={(_event, data) => onDraftChange({ bundleText: data.value })}
        />
      </Field>
      <div className={styles.row}>
        {bundles.map((example) => (
          <Button
            key={example.id}
            appearance="outline"
            disabled={loading}
            icon={loading ? <Spinner size="tiny" /> : undefined}
            onClick={() => void loadExample(example)}
          >
            Load example: {example.title}
          </Button>
        ))}
        <label htmlFor={inputId} className={styles.small}>
          Or open a .json file:{' '}
        </label>
        <input
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept=".json,application/json"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </div>
    </div>
  );
}

/** Downloads of the JSON Schemas and the example cases (synthetic), fetched with the caller's identity. */
function DownloadsPanel({ examples }: Pick<SourceStepProps, 'examples'>) {
  const styles = useStyles();
  const download = useDownload();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, target: Parameters<typeof download>[0]): Promise<void> => {
    setBusy(key);
    try {
      await download(target);
      toast.success(`Downloaded ${target.fileName}`);
    } catch (error) {
      toast.error('The download failed', { body: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const schemas = [
    {
      key: 'schema-bundle',
      title: 'Case bundle JSON Schema',
      description: 'Every field a JSON case bundle may contain, with its limits.',
      target: { route: 'schemas.caseBundle', fileName: 'case-bundle.schema.json' } as const,
    },
    {
      key: 'schema-pack',
      title: 'Knowledge pack JSON Schema',
      description: 'The format of the authored workload knowledge the analysis uses.',
      target: { route: 'schemas.knowledgePack', fileName: 'knowledge-pack.schema.json' } as const,
    },
  ];

  return (
    <Panel
      title="Schemas and examples"
      level={3}
      description="Start from a valid file instead of a blank page."
      help="The schemas describe exactly what the API validates. The examples are synthetic cases in each supported format (a JSON bundle, a transcript and a CSV of events); download one, edit it, then upload or paste it."
    >
      <ul className={styles.downloads} aria-label="JSON Schemas">
        {schemas.map((item) => (
          <li key={item.key} className={styles.download}>
            <div>
              <strong>{item.title}</strong>
              <p className={styles.small}>{item.description}</p>
            </div>
            <Button
              size="small"
              appearance="outline"
              icon={busy === item.key ? <Spinner size="extra-tiny" /> : <ArrowDownloadRegular />}
              disabled={busy !== null}
              aria-label={`Download ${item.title}`}
              onClick={() => void run(item.key, item.target)}
            >
              Download
            </Button>
          </li>
        ))}
      </ul>
      <h4 className={styles.hint}>Example cases (synthetic)</h4>
      {examples.isPending ? (
        <LoadingSkeleton variant="list" count={2} label="Loading examples" />
      ) : examples.isError ? (
        <ErrorState
          compact
          title="The examples could not be loaded"
          description={describeError(examples.error)}
          onRetry={() => void examples.refetch()}
        />
      ) : examples.data.items.length === 0 ? (
        <p className={styles.small}>No example files are available.</p>
      ) : (
        <ul className={styles.downloads} aria-label="Example cases">
          {examples.data.items.map((example) => (
            <li key={example.id} className={styles.download}>
              <div>
                <strong>{example.title}</strong>
                <p className={styles.small}>
                  {example.description} ({example.fileName}, {formatBytes(example.sizeBytes)})
                </p>
              </div>
              <Button
                size="small"
                appearance="outline"
                icon={
                  busy === example.id ? <Spinner size="extra-tiny" /> : <ArrowDownloadRegular />
                }
                disabled={busy !== null}
                aria-label={`Download example ${example.fileName}`}
                onClick={() =>
                  void run(example.id, {
                    route: 'examples.get',
                    exampleId: example.id,
                    fileName: example.fileName,
                  })
                }
              >
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** True while nothing has been provided yet: the status line then says what is needed (other problems show inline). */
function missingInput(draft: SourceDraft): boolean {
  switch (draft.choice) {
    case 'paste':
      return draft.pasteText.trim() === '';
    case 'bundle':
      return draft.bundleText.trim() === '';
    case 'file':
      return draft.file === null;
    default:
      return false;
  }
}

/** Step 1: choose where the case comes from and provide it; "Validate and preview" runs the real pipeline without saving. */
export function SourceStep(props: SourceStepProps) {
  const styles = useStyles();
  const { draft, onChoiceChange, onSubmit, pending, problem, retryIn } = props;
  const tabId = (choice: SourceChoice): string => `source-tab-${choice}`;
  const panelId = `source-panel-${draft.choice}`;
  const problems = draftProblems(draft);
  const ready = problems.length === 0;

  return (
    <div className={styles.layout}>
      <div className={styles.stack}>
        <Panel
          title="Choose where the case comes from"
          level={3}
          description="Nothing is saved until you confirm. First you see how the case would be read."
        >
          <TabList
            className={styles.tabs}
            selectedValue={draft.choice}
            onTabSelect={(_event, data) => onChoiceChange(data.value as SourceChoice)}
            aria-label="Case source"
          >
            {SOURCE_CHOICES.map((choice) => (
              <Tab
                key={choice}
                id={tabId(choice)}
                value={choice}
                icon={TAB_ICONS[choice]}
                aria-controls={choice === draft.choice ? panelId : undefined}
              >
                {SOURCE_CHOICE_LABELS[choice]}
              </Tab>
            ))}
          </TabList>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(draft.choice)}>
            {draft.choice === 'sample' ? (
              <SamplePanel
                draft={draft}
                samples={props.samples}
                onSampleChange={props.onSampleChange}
              />
            ) : null}
            {draft.choice === 'paste' ? (
              <PastePanel
                draft={draft}
                onDraftChange={props.onDraftChange}
                examples={props.examples}
                samples={props.samples}
              />
            ) : null}
            {draft.choice === 'file' ? (
              <FilePanel
                draft={draft}
                onDraftChange={props.onDraftChange}
                samples={props.samples}
              />
            ) : null}
            {draft.choice === 'bundle' ? (
              <BundlePanel
                draft={draft}
                onDraftChange={props.onDraftChange}
                examples={props.examples}
              />
            ) : null}
          </div>
          {problem ? (
            <ProblemView
              problem={problem}
              retryIn={retryIn}
              onRetry={onSubmit}
              retrying={pending}
              retryLabel="Validate again"
            />
          ) : null}
          <div className={styles.actions}>
            <GatedAction permission="case:ingest">
              <Button
                appearance="primary"
                disabled={!ready || pending}
                icon={pending ? <Spinner size="tiny" /> : undefined}
                onClick={onSubmit}
              >
                {pending ? 'Checking…' : 'Validate and preview'}
              </Button>
            </GatedAction>
            <p className={styles.small} role="status">
              {pending
                ? 'Validating, redacting and screening the content…'
                : missingInput(draft)
                  ? (problems[0]?.message ?? '')
                  : ''}
            </p>
          </div>
        </Panel>
      </div>
      <DownloadsPanel examples={props.examples} />
    </div>
  );
}
