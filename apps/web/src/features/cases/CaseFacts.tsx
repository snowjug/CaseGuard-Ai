'use client';

import type { CaseDetail } from '@caseguard/schemas';
import {
  BadgeShell,
  CopyButton,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryRegular } from '@fluentui/react-icons';
import { SOURCE_KIND_LABELS, countOf } from '../../components/case/labels';
import { CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';
import { DeleteCaseButton } from './DeleteCaseButton';

const useStyles = makeStyles({
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '22px',
    padding: `0 ${cg.space[2]}`,
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  hindsight: { backgroundColor: cg.surfaceSunken },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

export interface CaseFactsProps {
  detail: CaseDetail;
  /** The temporal boundary: facts that only the finished record knows (status, closing, last event) are not shown. */
  asOf: string | null;
  /** Events known at the boundary, when it is set and the count has loaded. */
  knownEvents: number | null;
}

/** The case's facts as recorded at ingestion, plus how it was received, redacted and screened. */
export function CaseFacts({ detail, asOf, knownEvents }: CaseFactsProps) {
  const styles = useStyles();
  const items = [
    {
      id: 'reference',
      label: 'Reference',
      value: (
        <span>
          <span className={styles.mono}>{detail.reference}</span>{' '}
          <CopyButton value={detail.reference} label="Copy case reference" />
        </span>
      ),
    },
    { id: 'product', label: 'Product', value: detail.product },
    { id: 'workload', label: 'Workload', value: detail.workload },
    { id: 'severity', label: 'Severity', value: SEVERITY_LABELS[detail.severity] },
    { id: 'customer', label: 'Customer (synthetic alias)', value: detail.customerAlias },
    { id: 'opened', label: 'Opened', value: formatDateTimeUtc(detail.openedAt) },
    ...(asOf === null
      ? [
          { id: 'status', label: 'Status', value: CASE_STATUS_LABELS[detail.status] },
          {
            id: 'closed',
            label: 'Closed',
            value: detail.closedAt ? formatDateTimeUtc(detail.closedAt) : 'Not closed',
          },
          { id: 'events', label: 'Events', value: formatNumber(detail.eventCount) },
          { id: 'last', label: 'Last event', value: formatDateTimeUtc(detail.lastEventAt) },
        ]
      : [
          {
            id: 'events',
            label: 'Events known',
            value: knownEvents === null ? 'Counting…' : formatNumber(knownEvents),
            hint: 'Status, closing and later events are withheld.',
          },
        ]),
    {
      id: 'id',
      label: 'Case ID',
      value: (
        <span>
          <span className={styles.mono}>{detail.id}</span>{' '}
          <CopyButton value={detail.id} label="Copy case ID" />
        </span>
      ),
    },
  ];
  const source = detail.source;
  return (
    <>
      <Panel
        title="Key facts"
        level={2}
        actions={detail.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      >
        <KeyValueList columns={1} layout="inline" items={items} aria-label="Key facts" />
        {detail.tags.length > 0 ? (
          <ul className={styles.chips} aria-label="Tags">
            {detail.tags.map((tag) => (
              <li key={tag} className={styles.chip}>
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Panel
        title="How it was received"
        level={2}
        description="The original events are an immutable record of what was stored after redaction."
      >
        <KeyValueList
          columns={1}
          layout="inline"
          aria-label="Source and screening"
          items={[
            { id: 'kind', label: 'Source', value: SOURCE_KIND_LABELS[source.kind] },
            ...(source.fileName ? [{ id: 'file', label: 'File', value: source.fileName }] : []),
            {
              id: 'size',
              label: 'Size',
              value: `${formatNumber(source.sizeBytes, { maximumFractionDigits: 0 })} bytes`,
            },
            {
              id: 'redaction',
              label: 'Redaction',
              value: source.redactionApplied ? (
                <StatusBadge
                  status="uncertain"
                  size="small"
                  label={`${countOf(source.redactionReplacements, 'value')} replaced`}
                />
              ) : (
                'Nothing needed redaction'
              ),
            },
            {
              id: 'injection',
              label: 'Prompt-injection screening',
              value: detail.injectionDetected ? (
                <StatusBadge status="uncertain" size="small" label="Flagged" />
              ) : (
                'Nothing flagged'
              ),
            },
            {
              id: 'received',
              label: 'SHA-256 as received',
              value: (
                <span>
                  <span className={styles.mono}>{source.receivedSha256.slice(0, 16)}…</span>{' '}
                  <CopyButton value={source.receivedSha256} label="Copy received hash" />
                </span>
              ),
            },
            {
              id: 'stored',
              label: 'SHA-256 as stored',
              value: (
                <span>
                  <span className={styles.mono}>{source.storedSha256.slice(0, 16)}…</span>{' '}
                  <CopyButton value={source.storedSha256} label="Copy stored hash" />
                </span>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}

/**
 * The recorded outcome of the case. It is known only after the fact, so it is kept structurally apart, labelled as
 * hindsight, never shown while a time cursor is set, and nothing on this page is generated from it.
 */
export function HindsightPanel({ detail, asOf }: { detail: CaseDetail; asOf: string | null }) {
  const styles = useStyles();
  const resolution = detail.resolution;
  return (
    <Panel
      title="Recorded resolution"
      level={2}
      accent="neutral"
      className={styles.hindsight}
      description="The outcome recorded when the case ended."
    >
      <div className={styles.head}>
        <BadgeShell
          tone="neutral"
          pattern="hatch"
          icon={<HistoryRegular />}
          label="Hindsight (not used to generate)"
          size="medium"
          borderStyle="dashed"
        />
      </div>
      {asOf !== null ? (
        <Notice variant="info" compact title={null}>
          The recorded resolution is hidden while a time cursor is set, because it was only known
          after the moment you are looking at.
        </Notice>
      ) : !resolution ? (
        <p className={styles.text}>No resolution was recorded with this case.</p>
      ) : (
        <>
          <p className={styles.text}>
            Recorded {formatDateTimeUtc(resolution.resolvedAt)}. The analysis, hypotheses and
            counterfactuals are generated without it; it is only used to check them afterwards.
          </p>
          <KeyValueList
            columns={1}
            items={[
              { id: 'summary', label: 'Summary', value: resolution.summary },
              { id: 'cause', label: 'Recorded root cause', value: resolution.rootCause },
              ...(resolution.workaround
                ? [{ id: 'workaround', label: 'Workaround', value: resolution.workaround }]
                : []),
              ...(resolution.permanentFix
                ? [{ id: 'fix', label: 'Permanent fix', value: resolution.permanentFix }]
                : []),
              ...(resolution.validation
                ? [
                    {
                      id: 'validation',
                      label: `Validation (${resolution.validation.outcome})`,
                      value: resolution.validation.method,
                      hint: `Validated ${formatDateTimeUtc(resolution.validation.validatedAt)}`,
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}
    </Panel>
  );
}

/** Administrator-only erasure, kept away from the primary actions. */
export function ManagePanel({ detail, onDeleted }: { detail: CaseDetail; onDeleted: () => void }) {
  const styles = useStyles();
  return (
    <Panel
      title="Manage this case"
      level={2}
      description="The record itself cannot be edited. An administrator can remove it entirely."
    >
      <div className={styles.actions}>
        <DeleteCaseButton
          caseId={detail.id}
          reference={detail.reference}
          title={detail.title}
          display="text"
          onDeleted={onDeleted}
        />
      </div>
    </Panel>
  );
}
