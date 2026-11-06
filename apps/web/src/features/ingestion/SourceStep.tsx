'use client';

import type { ExampleInfo, SampleBundleInfo } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  BlurFade,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  HelpButton,
  Input,
  ProvenanceBadge,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
  VisuallyHidden,
  borderColors,
  cg,
  formatNumber,
  useButtonClassName,
  useMediaQuery,
  useVisuallyHiddenClass,
  type SegmentOption,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowRightIcon,
  BracesIcon,
  CheckIcon,
  CircleAlertIcon,
  ClipboardPasteIcon,
  DownloadIcon,
  FileJsonIcon,
  FileTextIcon,
  FlaskConicalIcon,
  UploadIcon,
  ZapIcon,
} from 'lucide-react';
import { useId, useState, type DragEvent, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { countOf } from '../../components/case/labels';
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
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  card: {
    gap: cg.space[4],
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  pickRow: { display: 'flex', alignItems: 'center', minWidth: 0 },
  help: { margin: `0 0 ${cg.space[2]}`, ':last-child': { marginBottom: 0 } },
  // The help button is taller than the hint line it sits in: pulled in so it does not push the line apart.
  helpSlot: {
    display: 'inline-flex',
    verticalAlign: 'middle',
    marginBlock: `calc(-1 * ${cg.space[2]})`,
  },
  // The help button flows with the words of the hint, so on a phone it stays at the end of the last line.
  hintText: { minWidth: 0 },
  panel: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  small: { margin: 0, color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  hintRow: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: cg.space[4],
  },
  count: { fontVariantNumeric: 'tabular-nums' },
  paste: { minHeight: '176px', '@media (max-width: 639px)': { minHeight: '160px' } },
  bundle: {
    minHeight: '176px',
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    '@media (max-width: 639px)': { minHeight: '160px' },
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  // The name of an example comes from the API and can be longer than a phone is wide: it wraps instead of widening the page.
  example: {
    maxWidth: '100%',
    whiteSpace: 'normal',
    textAlign: 'start',
    lineHeight: tokens.lineHeightBase200,
    paddingBlock: cg.space[1],
  },
  details: { borderTop: `1px solid ${cg.borderSubtle}` },
  fields: {
    display: 'grid',
    alignItems: 'start',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  sampleGrid: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 720px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  sample: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    columnGap: cg.space[3],
    rowGap: cg.space[2],
    alignItems: 'start',
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceRaised,
    transitionProperty: 'transform, border-color, background-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { transform: 'translateY(-2px)', ...borderColors(cg.borderControl) },
    ':has(input:focus-visible)': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    // Where there is room the badge sits at the end of the first line; on a phone it goes under the name.
    '@media (min-width: 480px)': { gridTemplateColumns: 'auto minmax(0, 1fr) auto' },
  },
  sampleBadge: {
    gridColumn: '2',
    justifySelf: 'start',
    '@media (min-width: 480px)': { gridColumn: '3', gridRow: '1', justifySelf: 'end' },
  },
  sampleSelected: {
    ...borderColors(cg.tone.brand.border),
    backgroundColor: cg.tone.brand.tint,
    boxShadow: `inset 0 0 0 1px ${cg.tone.brand.border}`,
    ':hover': borderColors(cg.tone.brand.border),
  },
  // The radio covers its whole card: a click anywhere selects it, and keyboard focus lands on it.
  sampleInput: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    opacity: 0,
    cursor: 'pointer',
  },
  indicator: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    alignSelf: 'center',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.tone.brand.onSolid,
    fontSize: tokens.fontSizeBase200,
  },
  indicatorOn: { ...borderColors(cg.tone.brand.solid), backgroundColor: cg.tone.brand.solid },
  sampleName: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  sampleRef: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.tone.brand.fg,
  },
  sampleTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  sampleBody: {
    gridColumn: '2 / -1',
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
  },
  sampleText: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  sampleSkeleton: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.glassBorder}`,
  },
  zone: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: cg.space[2],
    padding: `${cg.space[8]} ${cg.space[4]}`,
    borderRadius: cg.radius.lg,
    border: `1px dashed ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    cursor: 'pointer',
    transitionProperty: 'border-color, background-color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': borderColors(cg.tone.brand.border),
    ':has(input:focus-visible)': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  zoneActive: { ...borderColors(cg.tone.brand.border), backgroundColor: cg.tone.brand.tint },
  zoneIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceRaised,
    backgroundImage: `radial-gradient(circle at 50% 0%, ${cg.glow}, transparent 70%)`,
    boxShadow: `0 12px 32px -12px ${cg.glow}`,
    color: cg.tone.brand.fg,
    fontSize: '24px',
  },
  zoneTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  zoneHint: { color: cg.textMuted, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  choose: { marginTop: cg.space[2] },
  buttonIcon: { display: 'inline-flex', fontSize: '1.2em' },
  fileButton: {
    ':has(input:focus-visible)': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[1],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.tone.unsupported.fg,
  },
  note: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  noteIcon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg, fontSize: '16px' },
  more: { borderTop: `1px solid ${cg.borderSubtle}` },
  downloads: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  groupTitle: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  downloadList: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  download: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: cg.space[3],
    alignItems: 'center',
    padding: `${cg.space[3]} 0`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    ':last-child': { borderBottom: 0 },
  },
  downloadText: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  downloadTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightMedium },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  primary: { '@media (max-width: 639px)': { width: '100%' } },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
});

const SOURCE_ICONS: Record<SourceChoice, ReactNode> = {
  paste: <ClipboardPasteIcon />,
  file: <UploadIcon />,
  sample: <FlaskConicalIcon />,
  bundle: <BracesIcon />,
};

const SEGMENTS: readonly SegmentOption<SourceChoice>[] = SOURCE_CHOICES.map((choice) => ({
  value: choice,
  label: SOURCE_CHOICE_LABELS[choice],
  icon: SOURCE_ICONS[choice],
}));

/** On a phone the four segments only fit without their icons. */
const SEGMENTS_COMPACT: readonly SegmentOption<SourceChoice>[] = SOURCE_CHOICES.map((choice) => ({
  value: choice,
  label: SOURCE_CHOICE_LABELS[choice],
}));

/**
 * The long explanations that used to sit above each field, one popover per source, next to the one short hint that stays
 * visible. (The built-in samples need none: their one-line hint says it all.)
 */
const SOURCE_HELP: Record<
  Exclude<SourceChoice, 'sample'>,
  { label: string; title: string; paragraphs: string[] }
> = {
  paste: {
    label: 'About pasted text',
    title: 'Pasted text',
    paragraphs: [
      'Paste an email thread, call notes or a support transcript. Use fictional data only: values that look like secrets or personal data (keys, tokens, email addresses, IP addresses, phone numbers) are redacted before anything is stored, and you see what was redacted before you create the case.',
      'Lines that carry only a time are dated from the day you paste, so the same text pasted on another day becomes a new case. Text with full dates always gives the same case: pasting it again returns the case that already exists instead of a copy.',
    ],
  },
  file: {
    label: 'About uploaded files',
    title: 'Uploaded files',
    paragraphs: [
      'Upload a JSON case bundle, a CSV of events or a plain-text transcript. The server checks the file by its content, not its name, and refuses executables, binaries and files that are too large (2 MB by default).',
    ],
  },
  bundle: {
    label: 'About JSON bundles',
    title: 'JSON bundles',
    paragraphs: [
      'Provide a case bundle in the CaseGuard JSON format; the schema is under "More ways to add". Every field is checked and errors are listed with their path.',
      'The bundle must declare "synthetic": true unless this workspace accepts real data.',
    ],
  },
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

/** The help popover of a source, right after the one short hint it belongs to. */
function InlineHelp({ source }: { source: Exclude<SourceChoice, 'sample'> }) {
  const styles = useStyles();
  const copy = SOURCE_HELP[source];
  return (
    <span className={styles.helpSlot}>
      <HelpButton label={copy.label} title={copy.title}>
        {copy.paragraphs.map((text) => (
          <p key={text} className={styles.help}>
            {text}
          </p>
        ))}
      </HelpButton>
    </span>
  );
}

function SamplesSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.sampleGrid}>
      <VisuallyHidden>Loading samples…</VisuallyHidden>
      {[0, 1].map((index) => (
        <div key={index} className={styles.sampleSkeleton}>
          <Skeleton width="34%" height={12} />
          <Skeleton height={16} />
          <Skeleton width="62%" height={12} />
          <Skeleton height={12} />
        </div>
      ))}
    </div>
  );
}

function SamplePanel({
  draft,
  samples,
  onSampleChange,
  onChoiceChange,
}: Pick<SourceStepProps, 'draft' | 'samples' | 'onSampleChange' | 'onChoiceChange'>) {
  const styles = useStyles();
  if (samples.isPending) return <SamplesSkeleton />;
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
        icon={<FlaskConicalIcon />}
        title="No built-in samples are available"
        description="Paste text, upload a file or provide a JSON bundle instead."
        action={
          <Button variant="secondary" onClick={() => onChoiceChange('paste')}>
            Paste text
          </Button>
        }
      />
    );
  }
  return (
    <div className={styles.panel}>
      <div role="radiogroup" aria-label="Built-in sample" className={styles.sampleGrid}>
        {items.map((sample) => {
          const selected = draft.sampleId === sample.id;
          const descriptionId = `sample-${sample.id}-description`;
          return (
            <div
              key={sample.id}
              className={mergeClasses(styles.sample, selected && styles.sampleSelected)}
            >
              {/* One string names the radio, the same in every browser; the two-line layout below is for the eyes. */}
              <input
                type="radio"
                name="built-in-sample"
                value={sample.id}
                checked={selected}
                className={styles.sampleInput}
                aria-label={`${sample.reference}: ${sample.title}`}
                aria-describedby={descriptionId}
                onChange={() => onSampleChange(sample.id)}
              />
              <span
                aria-hidden="true"
                className={mergeClasses(styles.indicator, selected && styles.indicatorOn)}
              >
                {selected ? <CheckIcon /> : null}
              </span>
              <span aria-hidden="true" className={styles.sampleName}>
                <span className={styles.sampleRef}>{sample.reference}</span>
                <span className={styles.sampleTitle}>{sample.title}</span>
              </span>
              <span className={styles.sampleBadge}>
                <ProvenanceBadge kind="synthetic" />
              </span>
              <span id={descriptionId} className={styles.sampleBody}>
                <span className={styles.small}>
                  {sample.workload} · {countOf(sample.eventCount, 'event')} ·{' '}
                  {sample.role === 'primary' ? 'first case of the story' : 'follow-up case'}
                </span>
                <span
                  className={styles.sampleText}
                  style={{ WebkitLineClamp: 2 }}
                  title={sample.description}
                >
                  {sample.description}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <p className={styles.small}>
        Built-in cases are synthetic: every person, organisation and incident in them is fictional.
      </p>
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
  onChoiceChange,
  examples,
  samples,
}: Pick<SourceStepProps, 'draft' | 'onDraftChange' | 'onChoiceChange' | 'examples' | 'samples'>) {
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
  const tooLong = length > PASTE_MAX_CHARS;
  // The optional fields stay folded until there is something in them to see: a value, or a problem with one.
  const [detailsOpen, setDetailsOpen] = useState(
    draft.title.trim() !== '' || draft.workload.trim() !== '',
  );
  if (!detailsOpen && (titleProblem || workloadProblem)) setDetailsOpen(true);
  return (
    <div className={styles.panel}>
      <Field
        label="Case text"
        required
        hint={
          <span className={styles.hintRow}>
            <span className={styles.hintText}>
              Fictional data only. Secrets and personal data are redacted before saving.{' '}
              <InlineHelp source="paste" />
            </span>
            <span className={styles.count}>
              {`${formatNumber(length)} of ${formatNumber(PASTE_MAX_CHARS)} characters`}
            </span>
          </span>
        }
        error={
          tooLong
            ? `This is over the limit of ${formatNumber(PASTE_MAX_CHARS)} characters. Shorten it or split the case.`
            : undefined
        }
      >
        <Textarea
          className={styles.paste}
          rows={10}
          placeholder="Paste an email thread, call notes or a support transcript"
          value={draft.pasteText}
          onChange={(event) => onDraftChange({ pasteText: event.target.value })}
        />
      </Field>
      <div className={styles.row}>
        {transcripts.map((example) => (
          <Button
            key={example.id}
            variant="ghost"
            size="sm"
            className={styles.example}
            icon={<FileTextIcon />}
            onClick={() => onDraftChange({ pasteText: example.pasteText ?? '' })}
          >
            Insert example: {example.title}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          icon={<FlaskConicalIcon />}
          onClick={() => onChoiceChange('sample')}
        >
          Try a sample case
        </Button>
      </div>
      <div className={styles.details}>
        <Accordion>
          <AccordionItem
            title="Details (optional)"
            subtitle="Title and workload"
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
          >
            <div className={styles.fields}>
              <Field
                label="Title (optional)"
                hint="Leave empty to let CaseGuard derive one."
                error={titleProblem?.message}
              >
                <Input
                  value={draft.title}
                  maxLength={TITLE_MAX + 20}
                  onChange={(event) => onDraftChange({ title: event.target.value })}
                />
              </Field>
              <Field
                label="Workload"
                hint={`Required unless a "Workload:" line comes before the first message.${supported}`}
                error={workloadProblem?.message}
              >
                <Input
                  value={draft.workload}
                  maxLength={WORKLOAD_MAX + 20}
                  onChange={(event) => onDraftChange({ workload: event.target.value })}
                />
              </Field>
            </div>
          </AccordionItem>
        </Accordion>
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
  const hidden = useVisuallyHiddenClass();
  const chooseLook = useButtonClassName({ variant: 'secondary', size: 'md' }, styles.choose);
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const file = draft.file;
  const problems = draftProblems(draft);
  const problem = problems.find((item) => item.field === 'file');
  const workloadProblem = problems.find((item) => item.field === 'workload');
  const needsWorkload = fileNeedsWorkload(file);
  const workloads = supportedWorkloads(samples);
  const workloadHint =
    file && needsWorkload
      ? `A ${extensionOf(file.name)} file does not say which workload it belongs to, and CaseGuard does not guess.`
      : 'This JSON bundle states its own workload, so nothing is needed here.';

  const onDragOver = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLLabelElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) onDraftChange({ file: dropped });
  };

  return (
    <div className={styles.panel}>
      {/* The whole zone is the label of the file input, so a click anywhere opens the file dialog. */}
      <label
        className={mergeClasses(styles.zone, dragging && styles.zoneActive)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <input
          className={hidden}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          aria-label="Choose a file"
          aria-describedby={`${inputId}-hint`}
          onChange={(event) => onDraftChange({ file: event.target.files?.[0] ?? null })}
        />
        <span aria-hidden="true" className={styles.zoneIcon}>
          {file ? <FileTextIcon /> : <UploadIcon />}
        </span>
        <span className={styles.zoneTitle}>{file ? 'File chosen' : 'Drop a file here'}</span>
        <span id={`${inputId}-hint`} className={styles.zoneHint}>
          {file
            ? `${file.name} · ${formatBytes(file.size)}${
                file.size > DEFAULT_UPLOAD_LIMIT_BYTES
                  ? ' · larger than the default 2 MB limit; the server may refuse it'
                  : ''
              }`
            : `${ACCEPTED_EXTENSIONS.join(' ')} · up to 2 MB`}
        </span>
        <span aria-hidden="true" className={chooseLook}>
          Choose a file
        </span>
      </label>
      {file && problem ? (
        <p role="alert" className={styles.error}>
          <CircleAlertIcon aria-hidden="true" />
          <span>
            {problem.message} Found {extensionOf(file.name) || 'no extension'}.
          </span>
        </p>
      ) : null}
      {file ? (
        <Field
          label="Workload"
          required={needsWorkload}
          hint={workloadHint}
          error={needsWorkload ? workloadProblem?.message : undefined}
        >
          {workloads.length > 0 ? (
            <Select
              value={draft.workload}
              disabled={!needsWorkload}
              onChange={(event) => onDraftChange({ workload: event.target.value })}
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
              disabled={!needsWorkload}
              maxLength={WORKLOAD_MAX + 20}
              onChange={(event) => onDraftChange({ workload: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      <p className={styles.note}>
        <span aria-hidden="true" className={styles.noteIcon}>
          <ZapIcon />
        </span>
        <span>Uploaded files are analysed as soon as the case is created.</span>
        <InlineHelp source="file" />
      </p>
    </div>
  );
}

function BundlePanel({
  draft,
  onDraftChange,
  examples,
}: Pick<SourceStepProps, 'draft' | 'onDraftChange' | 'examples'>) {
  const styles = useStyles();
  const hidden = useVisuallyHiddenClass();
  const openLook = useButtonClassName({ variant: 'secondary', size: 'sm' }, styles.fileButton);
  const client = useApiClient();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
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
      <Field
        label="Case bundle (JSON)"
        required
        hint={
          <span className={styles.hintText}>
            Use the CaseGuard JSON format. The schema is under &quot;More ways to add&quot;.{' '}
            <InlineHelp source="bundle" />
          </span>
        }
        error={touched ? problem?.message : undefined}
      >
        <Textarea
          className={styles.bundle}
          rows={10}
          spellCheck={false}
          value={draft.bundleText}
          onChange={(event) => onDraftChange({ bundleText: event.target.value })}
        />
      </Field>
      <div className={styles.row}>
        {bundles.map((example) => (
          <Button
            key={example.id}
            variant="secondary"
            size="sm"
            className={styles.example}
            icon={<FileJsonIcon />}
            loading={loading}
            onClick={() => void loadExample(example)}
          >
            Load example: {example.title}
          </Button>
        ))}
        <label className={openLook}>
          <input
            className={hidden}
            type="file"
            accept=".json,application/json"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
          <span aria-hidden="true" className={styles.buttonIcon}>
            <UploadIcon />
          </span>
          Open a .json file
        </label>
      </div>
    </div>
  );
}

function DownloadsSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.downloadList}>
      <VisuallyHidden>Loading examples…</VisuallyHidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.download}>
          <div className={styles.downloadText}>
            <Skeleton width="40%" height={14} />
            <Skeleton width="75%" height={12} />
          </div>
          <Skeleton width={96} height={32} />
        </div>
      ))}
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
    <div className={styles.downloads}>
      <p className={styles.small}>
        Download a schema or an example, edit it, then upload or paste it.
      </p>
      <h4 className={styles.groupTitle}>JSON Schemas</h4>
      <ul className={styles.downloadList} aria-label="JSON Schemas">
        {schemas.map((item) => (
          <li key={item.key} className={styles.download}>
            <div className={styles.downloadText}>
              <span className={styles.downloadTitle}>{item.title}</span>
              <span className={styles.small}>{item.description}</span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<DownloadIcon />}
              loading={busy === item.key}
              disabled={busy !== null && busy !== item.key}
              aria-label={`Download ${item.title}`}
              onClick={() => void run(item.key, item.target)}
            >
              Download
            </Button>
          </li>
        ))}
      </ul>
      <h4 className={styles.groupTitle}>Example cases (synthetic)</h4>
      {examples.isPending ? (
        <DownloadsSkeleton />
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
        <ul className={styles.downloadList} aria-label="Example cases">
          {examples.data.items.map((example) => (
            <li key={example.id} className={styles.download}>
              <div className={styles.downloadText}>
                <span className={styles.downloadTitle}>{example.title}</span>
                <span className={styles.small}>
                  {example.description} ({example.fileName}, {formatBytes(example.sizeBytes)})
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={<DownloadIcon />}
                loading={busy === example.id}
                disabled={busy !== null && busy !== example.id}
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
    </div>
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

/**
 * Step 1: where the case comes from, and the one button that runs the real checks ("Check case") without saving anything.
 * One card holds the source choice and its fields; schemas and examples to start from sit folded under it.
 */
export function SourceStep(props: SourceStepProps) {
  const styles = useStyles();
  const { draft, onChoiceChange, onSubmit, pending, problem, retryIn } = props;
  const problems = draftProblems(draft);
  const ready = problems.length === 0;
  const compact = useMediaQuery('(max-width: 479px)');

  return (
    <div className={styles.stack}>
      <BlurFade index={0}>
        <Card glow padding="md" className={styles.card}>
          <div className={styles.pickRow}>
            <SegmentedControl
              aria-label="Case source"
              value={draft.choice}
              onValueChange={onChoiceChange}
              options={compact ? SEGMENTS_COMPACT : SEGMENTS}
              size={compact ? 'sm' : 'md'}
              fullWidth={compact}
            />
          </div>
          {draft.choice === 'paste' ? (
            <PastePanel
              draft={draft}
              onDraftChange={props.onDraftChange}
              onChoiceChange={onChoiceChange}
              examples={props.examples}
              samples={props.samples}
            />
          ) : null}
          {draft.choice === 'file' ? (
            <FilePanel draft={draft} onDraftChange={props.onDraftChange} samples={props.samples} />
          ) : null}
          {draft.choice === 'sample' ? (
            <SamplePanel
              draft={draft}
              samples={props.samples}
              onSampleChange={props.onSampleChange}
              onChoiceChange={onChoiceChange}
            />
          ) : null}
          {draft.choice === 'bundle' ? (
            <BundlePanel
              draft={draft}
              onDraftChange={props.onDraftChange}
              examples={props.examples}
            />
          ) : null}
          {problem ? (
            <ProblemView
              problem={problem}
              retryIn={retryIn}
              onRetry={onSubmit}
              retrying={pending}
              retryLabel="Check again"
            />
          ) : null}
          <div className={styles.actions}>
            <GatedAction permission="case:ingest">
              <Button
                variant="primary"
                size="lg"
                className={styles.primary}
                disabled={!ready}
                loading={pending}
                icon={<ArrowRightIcon />}
                iconPosition="end"
                onClick={onSubmit}
              >
                {pending ? 'Checking…' : 'Check case'}
              </Button>
            </GatedAction>
            <p className={styles.status} role="status">
              {pending
                ? 'Checking the format, redaction and screening…'
                : missingInput(draft)
                  ? (problems[0]?.message ?? '')
                  : ''}
            </p>
          </div>
        </Card>
      </BlurFade>
      <BlurFade index={1} className={styles.more}>
        <Accordion>
          <AccordionItem
            title="More ways to add"
            subtitle="Schemas and examples for your own files"
            icon={<DownloadIcon />}
          >
            <DownloadsPanel examples={props.examples} />
          </AccordionItem>
        </Accordion>
      </BlurFade>
    </div>
  );
}
