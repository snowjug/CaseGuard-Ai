'use client';

import type { CaseDetail } from '@caseguard/schemas';
import {
  Badge,
  Card,
  CopyButton,
  KeyValueList,
  ProvenanceBadge,
  RelativeTime,
  StatusBadge,
  cg,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { SOURCE_KIND_LABELS, countOf } from '../../components/case/labels';
import { CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';

const useStyles = makeStyles({
  card: { gap: cg.space[6] },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
  },
  facts: {
    display: 'grid',
    gap: `${cg.space[4]} ${cg.space[6]}`,
    margin: 0,
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
  },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  term: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  value: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightMedium,
    overflowWrap: 'anywhere',
  },
  hint: {
    display: 'block',
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
  },
  foot: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  ids: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  id: { display: 'inline-flex', alignItems: 'center', gap: cg.space[1] },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  flags: { display: 'inline-flex', flexWrap: 'wrap', gap: cg.space[1] },
});

export interface KeyFactsProps {
  detail: CaseDetail;
  /** The temporal boundary: facts that only the finished record knows (status, closing, last event) are not shown. */
  asOf: string | null;
  /** Events known at the boundary, when it is set and the count has loaded. */
  knownEvents: number | null;
  /** The case in numbers, as links to the pages that show them (see `CaseLinks`). */
  links: ReactNode;
}

/**
 * The first thing on the page: what the case is about (product, workload, severity, customer), when it happened, and the
 * case in numbers. The reference and the case id are copyable at the foot. The case's title is not repeated: the case
 * header above every page of a case already carries it.
 */
export function KeyFacts({ detail, asOf, knownEvents, links }: KeyFactsProps) {
  const styles = useStyles();
  const headingId = useId();
  const facts: { id: string; label: string; value: ReactNode; hint?: string }[] = [
    { id: 'product', label: 'Product', value: detail.product },
    { id: 'workload', label: 'Workload', value: detail.workload },
    { id: 'severity', label: 'Severity', value: SEVERITY_LABELS[detail.severity] },
    { id: 'customer', label: 'Customer alias', value: detail.customerAlias },
    { id: 'opened', label: 'Opened', value: <RelativeTime value={detail.openedAt} /> },
    ...(asOf === null
      ? [
          { id: 'status', label: 'Status', value: CASE_STATUS_LABELS[detail.status] },
          {
            id: 'closed',
            label: 'Closed',
            value: detail.closedAt ? <RelativeTime value={detail.closedAt} /> : 'Not closed',
          },
          { id: 'last', label: 'Last event', value: <RelativeTime value={detail.lastEventAt} /> },
        ]
      : [
          {
            id: 'events',
            label: 'Events known',
            value: knownEvents === null ? 'Counting…' : formatNumber(knownEvents),
            hint: 'Status, closing and later events are withheld.',
          },
        ]),
  ];
  return (
    <Card hero glow padding="lg" role="group" aria-labelledby={headingId} className={styles.card}>
      <div className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          Key facts
        </h2>
        {detail.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      </div>
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.id} className={styles.fact}>
            <dt className={styles.term}>{fact.label}</dt>
            <dd className={styles.value}>
              {fact.value}
              {fact.hint ? <span className={styles.hint}>{fact.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {links}
      <div className={styles.foot}>
        {detail.tags.length > 0 ? (
          <ul className={styles.tags} aria-label="Tags">
            {detail.tags.map((tag) => (
              <li key={tag}>
                <Badge tone="neutral" outlined>
                  {tag}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <p className={styles.ids}>
          <span className={styles.id}>
            Reference <span className={styles.mono}>{detail.reference}</span>
            <CopyButton value={detail.reference} label="Copy case reference" />
          </span>
          <span className={styles.id}>
            Case ID <span className={styles.mono}>{detail.id}</span>
            <CopyButton value={detail.id} label="Copy case ID" />
          </span>
        </p>
      </div>
    </Card>
  );
}

/** What was received, in one line: the kind of source and its file. */
export function receivedSubtitle(detail: CaseDetail): string {
  const source = detail.source;
  return `${SOURCE_KIND_LABELS[source.kind]}${source.fileName ? ` · ${source.fileName}` : ''}`;
}

/** The two screening results that need a person's attention, visible while their section is closed. */
export function ReceivedFlags({ detail }: { detail: CaseDetail }) {
  const styles = useStyles();
  const source = detail.source;
  if (!source.redactionApplied && !detail.injectionDetected) return null;
  return (
    <span className={styles.flags}>
      {source.redactionApplied ? (
        <StatusBadge
          status="uncertain"
          size="small"
          label={`${countOf(source.redactionReplacements, 'value')} replaced`}
        />
      ) : null}
      {detail.injectionDetected ? (
        <StatusBadge status="uncertain" size="small" label="Flagged" />
      ) : null}
    </span>
  );
}

/** How the case was received, redacted and screened: the original events are an immutable record of what was stored. */
export function ReceivedDetails({ detail }: { detail: CaseDetail }) {
  const styles = useStyles();
  const source = detail.source;
  return (
    <div className={styles.stack}>
      <p className={styles.text}>
        The original events are an immutable record of what was stored after redaction.
      </p>
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
    </div>
  );
}

/** The label that keeps the recorded outcome apart from everything the review generates. */
export function KnownLaterBadge() {
  return (
    <Badge
      tone="neutral"
      dashed
      size="sm"
      icon={<HistoryIcon />}
      title="Hindsight: it was only known after the case ended, so it is never used to generate anything. It is used to check results afterwards."
    >
      Known only later
    </Badge>
  );
}

/**
 * The recorded outcome of the case. It is known only after the fact, so it is kept apart, labelled, never shown while an
 * earlier moment is shown, and nothing on this page is generated from it.
 */
export function ResolutionDetails({ detail, asOf }: { detail: CaseDetail; asOf: string | null }) {
  const styles = useStyles();
  const resolution = detail.resolution;
  if (asOf !== null) {
    return (
      <p className={styles.text}>
        The recorded resolution is hidden while an earlier moment is shown, because it was only
        known after the moment you are looking at.
      </p>
    );
  }
  if (!resolution) return <p className={styles.text}>No resolution was recorded with this case.</p>;
  return (
    <div className={styles.stack}>
      <p className={styles.text}>
        Recorded <RelativeTime value={resolution.resolvedAt} />. The review, the possible causes and
        the what-if paths are generated without it; it is only used to check them afterwards.
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
                  hint: (
                    <>
                      Validated <RelativeTime value={resolution.validation.validatedAt} />
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
