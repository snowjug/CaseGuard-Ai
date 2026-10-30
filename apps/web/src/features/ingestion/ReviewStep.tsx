'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type IngestionPreview,
  type RedactionCategory,
} from '@caseguard/schemas';
import {
  CopyButton,
  DataTable,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  type BadgeStatus,
  type DataTableColumn,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowRightRegular } from '@fluentui/react-icons';
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
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
  verdict: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  events: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  event: {
    display: 'grid',
    gap: cg.space[1],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    minWidth: 0,
  },
  eventHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
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
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
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

const SEVERITY_BADGES: Record<'low' | 'medium' | 'high', { label: string; status: BadgeStatus }> = {
  high: { label: 'High severity', status: 'unsupported' },
  medium: { label: 'Medium severity', status: 'uncertain' },
  low: { label: 'Low severity', status: 'neutral' },
};

type Issue = IngestionPreview['issues'][number];
type Finding = IngestionPreview['redaction']['findings'][number];
type Injection = IngestionPreview['injection']['findings'][number];

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

/** Plain explanation of one pipeline outcome, with the issues, redaction and injection details the API found. */
export function ReviewVerdict({
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
    <Panel
      title="Result of the check"
      level={3}
      description="The same pipeline that will store the case ran on your input, without saving anything."
    >
      <div className={styles.verdict}>
        {preview.ok ? (
          <StatusBadge status="productive" label="Ready to ingest" size="medium" />
        ) : (
          <StatusBadge status="unsupported" label="Cannot be ingested yet" size="medium" />
        )}
        <span className={styles.text}>
          {countOf(errors, 'error')} · {countOf(warnings, 'warning')}
        </span>
        {preview.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      </div>
      {preview.alreadyIngestedCaseId ? (
        <Notice variant="info" title="Identical content already exists">
          {preview.ok
            ? 'This exact content was ingested before. Creating it again does not duplicate anything: you get the existing case back.'
            : 'This exact content was ingested before, so nothing new would be created.'}{' '}
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
          validate again.
        </Notice>
      ) : null}
    </Panel>
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

function IssuesPanel({ issues }: { issues: readonly Issue[] }) {
  const styles = useStyles();
  const columns: readonly DataTableColumn<Issue>[] = [
    {
      id: 'severity',
      header: 'Severity',
      width: '110px',
      cell: (row) =>
        row.severity === 'error' ? (
          <StatusBadge status="unsupported" label="Error" size="small" />
        ) : (
          <StatusBadge status="uncertain" label="Warning" size="small" />
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
  return (
    <Panel
      title="Validation"
      description="Every problem the checks found, with the field it is about."
      level={3}
    >
      {issues.length === 0 ? (
        <p className={styles.text}>No problems were found.</p>
      ) : (
        <DataTable
          caption="Validation issues"
          columns={columns}
          rows={issues}
          getRowId={(row) => `${row.severity}:${row.path}:${row.message}`}
        />
      )}
    </Panel>
  );
}

function RedactionPanel({
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
  return (
    <Panel
      title="Redaction"
      level={3}
      description="Values that look like secrets or personal data are replaced before anything is stored."
      help="Detection is automatic and best-effort: it catches common token, key, password, email, IP and phone formats, but cannot recognise every sensitive value. Only paste fictional data. What you see here is exactly what would be stored."
    >
      {notRun ? (
        <p className={styles.text}>
          No redaction result is available: the content was refused before redaction finished, and
          nothing was stored. This is not a finding that the content is clean.
        </p>
      ) : redaction.applied ? (
        <>
          <p className={styles.text}>
            {countOf(redaction.totalReplacements, 'value')} will be replaced by the placeholders
            below. The original values are not stored.
          </p>
          <DataTable
            caption="Redactions by category"
            columns={columns}
            rows={redaction.findings}
            getRowId={(row) => row.category}
          />
        </>
      ) : (
        <p className={styles.text}>
          Nothing that looks like a secret or personal data was found. Redaction is best-effort, so
          keep the case free of real customer data.
        </p>
      )}
    </Panel>
  );
}

function InjectionPanel({
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
        <StatusBadge
          status={SEVERITY_BADGES[row.severity].status}
          label={SEVERITY_BADGES[row.severity].label}
          size="small"
        />
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
  return (
    <Panel
      title="Prompt-injection screening"
      level={3}
      description="Case text is untrusted data. Text that tries to instruct an AI model is flagged."
      help="Support cases can contain text written to manipulate an AI assistant, for example 'ignore your instructions'. CaseGuard screens every event, flags what it finds and records the flag on the case. Flagged text is evidence to read, never an instruction to follow."
    >
      {notRun ? (
        <p className={styles.text}>
          Screening did not run because the content was refused first. This is not a finding that
          the content is safe.
        </p>
      ) : injection.detected ? (
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
    </Panel>
  );
}

function SummaryPanel({ preview }: { preview: IngestionPreview }) {
  const summary = preview.summary;
  return (
    <Panel title="What would be created" level={3} description="Read from the validated content.">
      {summary ? (
        <KeyValueList
          columns={1}
          layout="inline"
          items={[
            { id: 'reference', label: 'Reference', value: summary.reference, mono: true },
            { id: 'title', label: 'Title', value: summary.title },
            { id: 'product', label: 'Product', value: summary.product },
            { id: 'workload', label: 'Workload', value: summary.workload },
            { id: 'events', label: 'Events', value: formatNumber(summary.eventCount) },
            {
              id: 'participants',
              label: 'Participants',
              value: formatNumber(summary.participantCount),
            },
            { id: 'first', label: 'First event', value: formatDateTimeUtc(summary.firstEventAt) },
            { id: 'last', label: 'Last event', value: formatDateTimeUtc(summary.lastEventAt) },
            {
              id: 'duration',
              label: 'Span',
              value: formatDuration(summary.durationHours * 60),
            },
            {
              id: 'resolution',
              label: 'Resolution recorded',
              value: summary.hasResolution ? 'Yes (kept as hindsight)' : 'No',
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
      ) : (
        <p>The content could not be read far enough to summarise it.</p>
      )}
    </Panel>
  );
}

function EventsPreview({ events }: { events: IngestionPreview['eventsPreview'] }) {
  const styles = useStyles();
  if (events.length === 0) return null;
  return (
    <Panel
      title="Timeline preview"
      level={3}
      description={`The first ${events.length} events in time order, after redaction.`}
    >
      <ol className={styles.events} aria-label="Preview of the first events">
        {events.map((event) => (
          <li key={event.id} className={styles.event}>
            <div className={styles.eventHead}>
              <span>{formatDateTimeUtc(event.timestamp)}</span>
              <span>{EVENT_TYPE_LABELS[event.type]}</span>
              <span>{PARTICIPANT_ROLE_LABELS[event.participantRole]}</span>
              <span className={styles.mono}>{event.id}</span>
            </div>
            {event.title ? <h4 className={styles.eventTitle}>{event.title}</h4> : null}
            <ExpandableText text={event.bodyExcerpt} lines={3} label="event text" />
          </li>
        ))}
      </ol>
    </Panel>
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
 * Step 2: what the pipeline made of the input: validation issues with their paths, what would be redacted (by category
 * and count), prompt-injection findings with severity, a preview of the timeline and the immutability notice. A preview
 * that says "not ok" explains why in words: a reference held by another case, a custom redaction pattern that could not
 * be applied, a value that redaction made too long, or identical content that already exists.
 */
export function ReviewStep({ preview, source, onBack, onContinue }: ReviewStepProps) {
  const styles = useStyles();
  const notRun = checksDidNotRun(preview);
  return (
    <div className={styles.stack}>
      <ReviewVerdict preview={preview} source={source} />
      <div className={styles.columns}>
        <div className={styles.stack}>
          <IssuesPanel issues={preview.issues} />
          <RedactionPanel redaction={preview.redaction} notRun={notRun} />
          <InjectionPanel injection={preview.injection} notRun={notRun} />
        </div>
        <div className={styles.stack}>
          <SummaryPanel preview={preview} />
          <Notice variant="info" title="This record is immutable">
            Creating the case stores exactly what is shown here, after redaction, as an immutable
            record of the original events. Events cannot be edited afterwards. An administrator can
            delete the whole case, and that is recorded in the audit log.
          </Notice>
        </div>
      </div>
      <EventsPreview events={preview.eventsPreview} />
      <div className={styles.actions}>
        <Button appearance="outline" icon={<ArrowLeftRegular />} onClick={onBack}>
          Change the source
        </Button>
        <Button
          appearance="primary"
          icon={<ArrowRightRegular />}
          iconPosition="after"
          disabled={!preview.ok}
          onClick={onContinue}
        >
          Continue to confirm
        </Button>
        {!preview.ok ? (
          <span className={styles.text} role="status">
            Fix the errors above first.
          </span>
        ) : null}
      </div>
    </div>
  );
}
