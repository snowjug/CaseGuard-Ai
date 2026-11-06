'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type IngestionPreview,
  type RedactionCategory,
} from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  BlurFade,
  Button,
  Card,
  CopyButton,
  DataTable,
  HelpButton,
  KeyValueList,
  Notice,
  ProvenanceBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  type DataTableColumn,
  type ToneName,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleXIcon,
  EyeOffIcon,
  InfoIcon,
  ListChecksIcon,
  LockIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { SOURCE_KIND_LABELS, countOf } from '../../components/case/labels';
import { caseHref } from '../../lib/deep-links';
import {
  REDACTION_REFUSAL_ADVICE,
  describeRedactionRefusal,
  redactionPatternLabels,
  referenceInUseOf,
} from './ingest-errors';
import { formatBytes, type SourceChoice } from './ingest-source';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  card: { gap: cg.space[4], '@media (max-width: 639px)': { padding: cg.space[4] } },
  result: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  resultIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: cg.radius.pill,
    fontSize: '20px',
  },
  resultOk: { color: cg.tone.productive.fg, backgroundColor: cg.tone.productive.tint },
  resultBad: { color: cg.tone.unsupported.fg, backgroundColor: cg.tone.unsupported.tint },
  resultText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    flex: '1 1 160px',
    minWidth: 0,
  },
  resultTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  sectionTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  sectionHead: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  small: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  summary: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  caseHead: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
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
  detail: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  events: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  event: {
    display: 'grid',
    gap: cg.space[1],
    padding: `${cg.space[3]} 0`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    minWidth: 0,
    ':last-child': { borderBottom: 0, paddingBottom: 0 },
  },
  eventHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontVariantNumeric: 'tabular-nums',
  },
  eventTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  showAll: { alignSelf: 'flex-start' },
  immutable: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  immutableIcon: { display: 'inline-flex', color: cg.tone.brand.fg },
  help: { margin: `0 0 ${cg.space[2]}`, ':last-child': { marginBottom: 0 } },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  forward: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
});

const REDACTION_LABELS: Record<RedactionCategory, string> = {
  bearer_token: 'Bearer token',
  api_key: 'API key',
  connection_string: 'Connection string',
  private_key: 'Private key',
  password_assignment: 'Password assignment',
  jwt: 'JSON Web Token',
  github_token: 'GitHub token',
  azure_storage_key: 'Azure storage key',
  email_address: 'Email address',
  ipv4_address: 'IPv4 address',
  phone_number: 'Phone number',
  custom: 'Custom pattern',
};

const SEVERITY_BADGES: Record<'low' | 'medium' | 'high', { label: string; tone: BadgeTone }> = {
  high: { label: 'High severity', tone: 'unsupported' },
  medium: { label: 'Medium severity', tone: 'uncertain' },
  low: { label: 'Low severity', tone: 'neutral' },
};

type BadgeTone = Extract<ToneName, 'productive' | 'uncertain' | 'unsupported' | 'neutral'>;

const TONE_ICONS: Record<BadgeTone, LucideIcon> = {
  productive: CircleCheckIcon,
  uncertain: TriangleAlertIcon,
  unsupported: CircleXIcon,
  neutral: InfoIcon,
};

/** A small status pill: the status colour, its icon and a word, so colour is never the only signal. */
function ToneBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  const Icon = TONE_ICONS[tone];
  return (
    <Badge tone={tone} size="sm" icon={<Icon />}>
      {children}
    </Badge>
  );
}

type Issue = IngestionPreview['issues'][number];
type Finding = IngestionPreview['redaction']['findings'][number];
type Injection = IngestionPreview['injection']['findings'][number];

/** How many events of the timeline preview show before "Show all": the rest is one click away. */
const PREVIEW_EVENTS_SHOWN = 5;

/** The issue paths the API uses for refusals that need their own explanation. */
const REFERENCE_PATH = 'case.reference';
const REDACTION_PATH = 'redaction';

/**
 * Refusals that are not about a field the person typed, found among the preview's issues. An issue carries no `reason`
 * token (only a create's Problem Details does), so these are found by path, and where a path is shared with ordinary
 * field errors (`case.reference`, a field that can also be badly formed) by the wording as well. `redaction` is a path of
 * its own, so it needs nothing more.
 */
function specialIssues(issues: readonly Issue[]) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const reference = errors.find(
    (issue) => issue.path === REFERENCE_PATH && referenceInUseOf(issue.message) !== null,
  );
  const redaction = errors.find((issue) => issue.path === REDACTION_PATH);
  // The message carries the prefix; the path is the field that no longer fits.
  const afterRedaction = errors.filter((issue) => /^After redaction:/i.test(issue.message));
  return { reference, redaction, afterRedaction };
}

/** True when the pipeline stopped before redaction and screening produced anything: their panels must not claim "clean". */
const checksDidNotRun = (preview: IngestionPreview): boolean => preview.summary === null;

/**
 * The result of the check, first: a short line ("Ready to create", or why not), then the refusals that need a word of
 * their own, then what would be created. The same pipeline that stores the case ran on the input without saving anything.
 */
function ResultCard({
  preview,
  source,
}: {
  preview: IngestionPreview;
  /** What the person provided, so advice never asks them to edit a payload they did not write. */
  source?: SourceChoice | undefined;
}) {
  const styles = useStyles();
  const errors = preview.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = preview.issues.length - errors;
  const { reference, redaction, afterRedaction } = specialIssues(preview.issues);
  const taken = reference ? referenceInUseOf(reference.message) : null;
  const takenReference = taken?.reference ?? preview.summary?.reference ?? null;
  const redactionLabels = redaction ? redactionPatternLabels(redaction.message) : [];
  return (
    <Card
      role="group"
      aria-label="Result of the check"
      glow={preview.ok}
      padding="md"
      className={styles.card}
    >
      <div className={styles.result}>
        <span
          aria-hidden="true"
          className={mergeClasses(
            styles.resultIcon,
            preview.ok ? styles.resultOk : styles.resultBad,
          )}
        >
          {preview.ok ? <CircleCheckIcon /> : <CircleXIcon />}
        </span>
        <div className={styles.resultText}>
          <h3 className={styles.resultTitle}>
            {preview.ok ? 'Ready to create' : 'Cannot be created yet'}
          </h3>
          <p className={styles.text}>
            {countOf(errors, 'error')} · {countOf(warnings, 'warning')}
          </p>
        </div>
        {preview.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      </div>
      {preview.alreadyIngestedCaseId ? (
        <Notice variant="info" title="Identical content already exists">
          {preview.ok
            ? 'This exact content was added before. Creating it again does not duplicate anything: you get the existing case back.'
            : 'This exact content was added before, so nothing new would be created.'}{' '}
          <UiLink href={caseHref(preview.alreadyIngestedCaseId)}>Open the existing case</UiLink>
        </Notice>
      ) : null}
      {reference ? (
        <Notice
          variant="warning"
          title={
            takenReference
              ? `Reference ${takenReference} is already in use`
              : 'That reference is already in use'
          }
        >
          Another case in this workspace has it, with different content. {referenceHelp(source)}{' '}
          <UiLink
            href={takenReference ? `/cases?q=${encodeURIComponent(takenReference)}` : '/cases'}
          >
            Find that case in the Cases list
          </UiLink>
        </Notice>
      ) : null}
      {redaction ? (
        <Notice variant="warning" title="Redaction could not be completed">
          {describeRedactionRefusal(redactionLabels)} {REDACTION_REFUSAL_ADVICE}{' '}
          <UiLink href="/governance?tab=redaction">Open Governance &gt; Redaction</UiLink>
        </Notice>
      ) : null}
      {afterRedaction.length > 0 ? (
        <Notice variant="warning" title="Redaction made a value too long">
          Redaction replaces secrets and personal data with placeholders that can be longer than the
          original, so{' '}
          {afterRedaction.length === 1
            ? 'a field no longer fits its limit'
            : `${afterRedaction.length} fields no longer fit their limits`}{' '}
          once redacted. Shorten {afterRedaction.length === 1 ? 'that field' : 'those fields'} (or
          remove the sensitive values from {afterRedaction.length === 1 ? 'it' : 'them'}), then
          check again.
        </Notice>
      ) : null}
      <ResultSummary preview={preview} />
    </Card>
  );
}

/** What would be created, read from the validated content: the case first, the rest of the facts folded. */
function ResultSummary({ preview }: { preview: IngestionPreview }) {
  const styles = useStyles();
  const summary = preview.summary;
  if (!summary) {
    return (
      <div className={styles.summary}>
        <p className={styles.text}>The content could not be read far enough to summarise it.</p>
      </div>
    );
  }
  return (
    <div className={styles.summary}>
      <div className={styles.caseHead}>
        <span className={styles.ref}>{summary.reference}</span>
        <p className={styles.caseTitle}>{summary.title}</p>
      </div>
      <KeyValueList
        columns={3}
        items={[
          { id: 'product', label: 'Product', value: summary.product },
          { id: 'workload', label: 'Workload', value: summary.workload },
          { id: 'events', label: 'Events', value: formatNumber(summary.eventCount) },
          {
            id: 'participants',
            label: 'Participants',
            value: formatNumber(summary.participantCount),
          },
          {
            id: 'duration',
            label: 'Span',
            value: formatDuration(summary.durationHours * 60),
          },
        ]}
      />
      <Accordion>
        <AccordionItem
          title="More details"
          subtitle="Dates, source, size and content hash"
          headingLevel={4}
        >
          <KeyValueList
            columns={3}
            items={[
              { id: 'first', label: 'First event', value: formatDateTimeUtc(summary.firstEventAt) },
              { id: 'last', label: 'Last event', value: formatDateTimeUtc(summary.lastEventAt) },
              {
                id: 'resolution',
                label: 'Resolution recorded',
                value: summary.hasResolution ? 'Yes' : 'No',
                ...(summary.hasResolution
                  ? { hint: 'Kept apart as information known only later.' }
                  : {}),
              },
              { id: 'source', label: 'Source', value: SOURCE_KIND_LABELS[preview.sourceKind] },
              { id: 'size', label: 'Size', value: formatBytes(preview.sizeBytes) },
              {
                id: 'hash',
                label: 'Content hash',
                value: (
                  <span>
                    {preview.contentHash.slice(0, 16)}…{' '}
                    <CopyButton value={preview.contentHash} label="Copy content hash" />
                  </span>
                ),
                hint: 'SHA-256 of the stored, redacted content.',
              },
            ]}
          />
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/** Advice on a taken reference that fits where the payload came from: never "edit" what the person did not write. */
function referenceHelp(source: SourceChoice | undefined): string {
  switch (source) {
    case 'bundle':
      return 'Change "case.reference" in your bundle to one this workspace does not use yet, or ask an administrator to delete the existing case first.';
    case 'sample':
      return "This sample's reference is held by a different case: ask an administrator to delete that case first.";
    default:
      return 'Pasted text and files have no reference field, so the reference is generated from the content. Use a different case reference, or ask an administrator to delete the existing case first.';
  }
}

function IssuesDetail({ issues }: { issues: readonly Issue[] }) {
  const styles = useStyles();
  const columns: readonly DataTableColumn<Issue>[] = [
    {
      id: 'severity',
      header: 'Severity',
      width: '110px',
      cell: (row) =>
        row.severity === 'error' ? (
          <ToneBadge tone="unsupported">Error</ToneBadge>
        ) : (
          <ToneBadge tone="uncertain">Warning</ToneBadge>
        ),
    },
    {
      id: 'path',
      header: 'Where',
      width: '30%',
      cell: (row) => <code className={styles.mono}>{row.path || 'payload'}</code>,
    },
    { id: 'message', header: 'What', cell: (row) => <span>{row.message}</span> },
  ];
  if (issues.length === 0) return <p className={styles.text}>No problems were found.</p>;
  return (
    <DataTable
      caption="Validation issues"
      columns={columns}
      rows={issues}
      getRowId={(row) => `${row.severity}:${row.path}:${row.message}`}
    />
  );
}

function RedactionDetail({
  redaction,
  notRun,
}: {
  redaction: IngestionPreview['redaction'];
  /** The content was refused before redaction finished: there is no result to report. */
  notRun: boolean;
}) {
  const styles = useStyles();
  const columns: readonly DataTableColumn<Finding>[] = [
    {
      id: 'category',
      header: 'Category',
      cell: (row) => <span>{REDACTION_LABELS[row.category]}</span>,
    },
    {
      id: 'count',
      header: 'Replaced',
      align: 'end',
      cell: (row) => <strong>{formatNumber(row.count)}</strong>,
    },
    {
      id: 'placeholder',
      header: 'Stored as',
      cell: (row) => <code className={styles.mono}>{row.placeholder}</code>,
    },
  ];
  if (notRun) {
    return (
      <p className={styles.text}>
        No redaction result is available: the content was refused before redaction finished, and
        nothing was stored. This is not a finding that the content is clean.
      </p>
    );
  }
  if (!redaction.applied) {
    return (
      <p className={styles.text}>
        Nothing that looks like a secret or personal data was found. Redaction is best-effort, so
        keep the case free of real customer data.
      </p>
    );
  }
  return (
    <div className={styles.detail}>
      <p className={styles.text}>
        {countOf(redaction.totalReplacements, 'value')} will be replaced by the placeholders below.
        The original values are not stored.
      </p>
      <DataTable
        caption="Redactions by category"
        columns={columns}
        rows={redaction.findings}
        getRowId={(row) => row.category}
      />
    </div>
  );
}

function InjectionDetail({
  injection,
  notRun,
}: {
  injection: IngestionPreview['injection'];
  /** The content was refused before screening: there is no result to report. */
  notRun: boolean;
}) {
  const styles = useStyles();
  const columns: readonly DataTableColumn<Injection>[] = [
    {
      id: 'severity',
      header: 'Severity',
      width: '130px',
      cell: (row) => (
        <ToneBadge tone={SEVERITY_BADGES[row.severity].tone}>
          {SEVERITY_BADGES[row.severity].label}
        </ToneBadge>
      ),
    },
    {
      id: 'where',
      header: 'Where',
      width: '120px',
      cell: (row) => (
        <span>
          {row.eventId ? `Event ${row.eventId}` : 'Case'}
          <br />
          <code className={styles.mono}>{row.ruleId}</code>
        </span>
      ),
    },
    {
      id: 'finding',
      header: 'Finding',
      cell: (row) => (
        <div>
          <p className={styles.text}>{row.explanation}</p>
          <ExpandableText text={row.excerpt} lines={2} label="excerpt" />
        </div>
      ),
    },
  ];
  if (notRun) {
    return (
      <p className={styles.text}>
        Screening did not run because the content was refused first. This is not a finding that the
        content is safe.
      </p>
    );
  }
  return (
    <div className={styles.detail}>
      <p className={styles.small}>
        Case text is untrusted data. Text that tries to instruct an AI model is flagged, and flagged
        text is evidence to read, never an instruction to follow.
      </p>
      {injection.detected ? (
        <>
          <p className={styles.text}>
            {countOf(injection.findings.length, 'finding')}; the highest severity is{' '}
            <strong>{injection.highestSeverity}</strong>. The case is flagged when you create it.
          </p>
          <DataTable
            caption="Prompt-injection findings"
            columns={columns}
            rows={injection.findings}
            getRowId={(row) => `${row.ruleId}:${row.eventId ?? 'case'}:${row.excerpt}`}
          />
        </>
      ) : (
        <p className={styles.text}>No prompt-injection patterns were detected.</p>
      )}
    </div>
  );
}

/** The three checks as calm rows: a word for the outcome up front, the detail one click away (open when it needs a look). */
function ChecksCard({ preview, notRun }: { preview: IngestionPreview; notRun: boolean }) {
  const styles = useStyles();
  const { issues, redaction, injection } = preview;
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const severityTone =
    SEVERITY_BADGES[injection.highestSeverity === 'none' ? 'low' : injection.highestSeverity].tone;
  return (
    <Card padding="md" className={styles.card}>
      <h3 className={styles.sectionTitle}>Checks</h3>
      <Accordion>
        <AccordionItem
          headingLevel={4}
          icon={<ListChecksIcon />}
          title="Format"
          subtitle={
            issues.length === 0 ? 'No problems found' : `${countOf(issues.length, 'problem')} found`
          }
          badge={
            issues.length === 0 ? (
              <ToneBadge tone="productive">Passed</ToneBadge>
            ) : errors > 0 ? (
              <ToneBadge tone="unsupported">Needs fixes</ToneBadge>
            ) : (
              <ToneBadge tone="uncertain">Warnings</ToneBadge>
            )
          }
          defaultOpen={issues.length > 0}
        >
          <IssuesDetail issues={issues} />
        </AccordionItem>
        <AccordionItem
          headingLevel={4}
          icon={<EyeOffIcon />}
          title="Redaction"
          subtitle={
            notRun
              ? 'Did not run'
              : redaction.applied
                ? `${countOf(redaction.totalReplacements, 'value')} replaced`
                : 'Nothing replaced'
          }
          badge={
            notRun ? (
              <ToneBadge tone="neutral">Not run</ToneBadge>
            ) : redaction.applied ? (
              <ToneBadge tone="uncertain">Values replaced</ToneBadge>
            ) : (
              <ToneBadge tone="productive">Passed</ToneBadge>
            )
          }
          defaultOpen={notRun || redaction.applied}
        >
          <RedactionDetail redaction={redaction} notRun={notRun} />
        </AccordionItem>
        <AccordionItem
          headingLevel={4}
          icon={<ShieldAlertIcon />}
          title="Injection screening"
          subtitle={
            notRun
              ? 'Did not run'
              : injection.detected
                ? `${countOf(injection.findings.length, 'finding')}, highest severity ${injection.highestSeverity}`
                : 'Nothing flagged'
          }
          badge={
            notRun ? (
              <ToneBadge tone="neutral">Not run</ToneBadge>
            ) : injection.detected ? (
              <ToneBadge tone={severityTone}>Flagged</ToneBadge>
            ) : (
              <ToneBadge tone="productive">Passed</ToneBadge>
            )
          }
          defaultOpen={notRun || injection.detected}
        >
          <InjectionDetail injection={injection} notRun={notRun} />
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

function EventsPreview({ events }: { events: IngestionPreview['eventsPreview'] }) {
  const styles = useStyles();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const folded = events.length > PREVIEW_EVENTS_SHOWN && !expanded;
  const shown = folded ? events.slice(0, PREVIEW_EVENTS_SHOWN) : events;
  return (
    <Card padding="md" className={styles.card}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Timeline preview</h3>
        <p className={styles.small}>
          {folded
            ? `The first ${shown.length} of ${events.length} events in time order, after redaction.`
            : events.length === 1
              ? 'The first event, after redaction.'
              : `The first ${events.length} events in time order, after redaction.`}
        </p>
      </div>
      <ol id={listId} className={styles.events} aria-label="Preview of the first events">
        {shown.map((event) => (
          <li key={event.id} className={styles.event}>
            <div className={styles.eventHead}>
              <span>{formatDateTimeUtc(event.timestamp)}</span>
              <Badge size="sm">{EVENT_TYPE_LABELS[event.type]}</Badge>
              <span>{PARTICIPANT_ROLE_LABELS[event.participantRole]}</span>
              <span className={styles.mono}>{event.id}</span>
            </div>
            {event.title ? <p className={styles.eventTitle}>{event.title}</p> : null}
            <ExpandableText text={event.bodyExcerpt} lines={3} label="event text" />
          </li>
        ))}
      </ol>
      {events.length > PREVIEW_EVENTS_SHOWN ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.showAll}
          aria-expanded={expanded}
          aria-controls={listId}
          icon={expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer events' : `Show all ${events.length} events`}
        </Button>
      ) : null}
    </Card>
  );
}

export interface ReviewStepProps {
  preview: IngestionPreview;
  /** What the person provided (drives the advice for a reference that is taken). */
  source?: SourceChoice | undefined;
  onBack: () => void;
  onContinue: () => void;
}

/**
 * Step 2, "Check what will be created": the result of the checks first (ready, or why not), the three checks with their
 * detail one click away, a preview of the timeline and the immutability statement. A preview that says "not ok"
 * explains why in words: a reference held by another case, a custom redaction pattern that could not be applied, a value
 * that redaction made too long, or identical content that already exists.
 */
export function ReviewStep({ preview, source, onBack, onContinue }: ReviewStepProps) {
  const styles = useStyles();
  const notRun = checksDidNotRun(preview);
  return (
    <div className={styles.stack}>
      <BlurFade index={0}>
        <ResultCard preview={preview} source={source} />
      </BlurFade>
      <BlurFade index={1}>
        <ChecksCard preview={preview} notRun={notRun} />
      </BlurFade>
      {preview.eventsPreview.length > 0 ? (
        <BlurFade index={2}>
          <EventsPreview events={preview.eventsPreview} />
        </BlurFade>
      ) : null}
      <BlurFade index={3} className={styles.stack}>
        <p className={styles.immutable}>
          <span aria-hidden="true" className={styles.immutableIcon}>
            <LockIcon />
          </span>
          <span>This record is immutable</span>
          <HelpButton label="About immutable records" title="Immutable record">
            <p className={styles.help}>
              Creating the case stores exactly what is shown here, after redaction, as an immutable
              record of the original events. Events cannot be edited afterwards.
            </p>
            <p className={styles.help}>
              An administrator can delete the whole case, and that is recorded in the audit log.
            </p>
          </HelpButton>
        </p>
        <div className={styles.actions}>
          <Button variant="ghost" icon={<ArrowLeftIcon />} onClick={onBack}>
            Back
          </Button>
          <div className={styles.forward}>
            {!preview.ok ? (
              <span className={styles.text} role="status">
                Fix the errors above first.
              </span>
            ) : null}
            <Button
              variant="secondary"
              icon={<ArrowRightIcon />}
              iconPosition="end"
              disabled={!preview.ok}
              onClick={onContinue}
            >
              Continue
            </Button>
          </div>
        </div>
      </BlurFade>
    </div>
  );
}
