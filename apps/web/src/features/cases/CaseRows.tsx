'use client';

import type { CaseSummary } from '@caseguard/schemas';
import {
  DataTable,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  VisuallyHidden,
  cg,
  formatDateUtc,
  formatNumber,
  formatPercent,
  formatProbability,
  sortRows,
  type DataTableColumn,
  type SortState,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
import { LinkButton } from '../../components/common/LinkButton';
import { countOf } from '../../components/case/labels';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';
import { sortValueOf } from './case-filters';
import { DeleteCaseButton } from './DeleteCaseButton';

const useStyles = makeStyles({
  caseCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '200px',
    padding: '4px 0',
    '@media (max-width: 1279px)': { minWidth: 0 },
  },
  dateCell: { display: 'flex', flexDirection: 'column', gap: '2px' },
  // The table primitive lays columns out equally and never narrower than its content; automatic layout honours the
  // column widths set below and shrinks the free columns to fit.
  table: { '& table': { tableLayout: 'auto', minWidth: 'min-content' } },
  link: {
    color: cg.textLink,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    textDecorationLine: 'none',
    width: 'fit-content',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
    ':hover': { textDecorationLine: 'underline' },
  },
  title: {
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
    maxWidth: '46ch',
  },
  meta: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[1] },
  number: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
  muted: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  hypothesis: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '140px' },
  actions: { display: 'flex', alignItems: 'center', gap: cg.space[1], flexWrap: 'wrap' },
  cards: {
    display: 'grid',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    minWidth: 0,
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    margin: 0,
  },
  factTerm: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  factValue: { margin: 0, fontSize: tokens.fontSizeBase300, overflowWrap: 'anywhere' },
});

const quality = (value: number | null): string =>
  value === null ? '—' : formatNumber(value, { maximumFractionDigits: 0 });

/** One line under the title: severity, status, product and workload. */
function caseMeta(item: CaseSummary): string {
  return `${SEVERITY_LABELS[item.severity]} · ${CASE_STATUS_LABELS[item.status]} · ${item.product} · ${item.workload}`;
}

function AnalysisBadges({ item }: { item: CaseSummary }) {
  const styles = useStyles();
  const analysis = ANALYSIS_STATE_BADGES[item.analysisState];
  return (
    <div className={styles.badges}>
      <StatusBadge status={analysis.status} label={analysis.label} size="small" />
      {item.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      {item.injectionDetected ? (
        <StatusBadge status="uncertain" label="Injection flagged" size="small" />
      ) : null}
    </div>
  );
}

function HypothesisCell({ item }: { item: CaseSummary }) {
  const styles = useStyles();
  if (!item.leadingHypothesis) return <span className={styles.muted}>Not available</span>;
  return (
    <div className={styles.hypothesis}>
      <span>{item.leadingHypothesis.name}</span>
      <span className={styles.muted}>
        {formatProbability(item.leadingHypothesis.confidence)} confidence (estimate)
      </span>
    </div>
  );
}

function openWarnings(count: number): string {
  return `${count} open ${count === 1 ? 'warning' : 'warnings'}`;
}

export interface CaseRowsProps {
  rows: readonly CaseSummary[];
  sort: SortState;
  onSortChange: (sort: SortState | null) => void;
  /** Cards instead of a table (narrow screens). */
  compact: boolean;
}

/** The loaded cases as a sortable table, or as cards on narrow screens. */
export function CaseRows({ rows, sort, onSortChange, compact }: CaseRowsProps) {
  const styles = useStyles();
  const columns = useMemo<readonly DataTableColumn<CaseSummary>[]>(
    () => [
      {
        id: 'reference',
        header: 'Case',
        rowHeader: true,
        sortValue: (row) => sortValueOf(row, 'reference'),
        cell: (row) => (
          <div className={styles.caseCell}>
            <UiLink href={caseHref(row.id)} className={styles.link}>
              {row.reference}
            </UiLink>
            <span className={styles.title}>{row.title}</span>
            <span className={styles.meta}>{caseMeta(row)}</span>
          </div>
        ),
      },
      {
        id: 'opened',
        header: 'Opened',
        width: '112px',
        sortValue: (row) => sortValueOf(row, 'opened'),
        cell: (row) => (
          <div className={styles.dateCell}>
            <span>{formatDateUtc(row.openedAt)}</span>
            <span className={styles.muted}>{countOf(row.eventCount, 'event')}</span>
          </div>
        ),
      },
      {
        id: 'analysis',
        header: 'Analysis',
        width: '112px',
        cell: (row) => <AnalysisBadges item={row} />,
      },
      {
        id: 'quality',
        header: 'Quality (est.)',
        align: 'end',
        width: '96px',
        sortValue: (row) => sortValueOf(row, 'quality'),
        cell: (row) =>
          row.qualityIndex === null ? (
            <span className={styles.muted}>Not available</span>
          ) : (
            <span className={styles.number}>
              {quality(row.qualityIndex)}
              <span className={styles.muted}> / 100</span>
            </span>
          ),
      },
      {
        id: 'effort',
        header: 'Avoidable effort (est.)',
        align: 'end',
        width: '120px',
        sortValue: (row) => sortValueOf(row, 'effort'),
        cell: (row) =>
          row.avoidableEffortPct === null ? (
            <span className={styles.muted}>Not available</span>
          ) : (
            <span className={styles.number}>{formatPercent(row.avoidableEffortPct, 0)}</span>
          ),
      },
      {
        id: 'hypothesis',
        header: 'Leading hypothesis',
        cell: (row) => <HypothesisCell item={row} />,
      },
      {
        id: 'warnings',
        header: 'Open warnings',
        align: 'end',
        width: '84px',
        sortValue: (row) => sortValueOf(row, 'warnings'),
        cell: (row) => <span className={styles.number}>{row.openWarningCount}</span>,
      },
      {
        id: 'actions',
        header: <VisuallyHidden>Actions</VisuallyHidden>,
        width: '112px',
        cell: (row) => (
          <div className={styles.actions}>
            <LinkButton href={caseHref(row.id)} appearance="subtle" size="small">
              Open
            </LinkButton>
            <DeleteCaseButton caseId={row.id} reference={row.reference} title={row.title} />
          </div>
        ),
      },
    ],
    [styles],
  );

  // "Events" is no longer a column of its own (the count sits under the opened date), but it stays a sort option.
  const sortColumns = useMemo<readonly DataTableColumn<CaseSummary>[]>(
    () => [
      ...columns,
      {
        id: 'events',
        header: 'Events',
        cell: () => null,
        sortValue: (row) => sortValueOf(row, 'events'),
      },
    ],
    [columns],
  );
  const ordered = useMemo(() => sortRows(rows, sortColumns, sort), [rows, sortColumns, sort]);

  if (compact) {
    return (
      <ul className={styles.cards} aria-label="Cases">
        {ordered.map((item) => (
          <li key={item.id} className={styles.card}>
            <div className={styles.caseCell}>
              <UiLink href={caseHref(item.id)} className={styles.link}>
                {item.reference}
              </UiLink>
              <span className={styles.title}>{item.title}</span>
              <span className={styles.meta}>
                {caseMeta(item)} · opened {formatDateUtc(item.openedAt)}
              </span>
            </div>
            <AnalysisBadges item={item} />
            <dl className={styles.facts}>
              <div>
                <dt className={styles.factTerm}>Quality (estimated)</dt>
                <dd className={styles.factValue}>
                  {item.qualityIndex === null
                    ? 'Not available'
                    : `${quality(item.qualityIndex)} / 100`}
                </dd>
              </div>
              <div>
                <dt className={styles.factTerm}>Avoidable effort (estimated)</dt>
                <dd className={styles.factValue}>
                  {item.avoidableEffortPct === null
                    ? 'Not available'
                    : formatPercent(item.avoidableEffortPct, 0)}
                </dd>
              </div>
              <div>
                <dt className={styles.factTerm}>Leading hypothesis</dt>
                <dd className={styles.factValue}>
                  <HypothesisCell item={item} />
                </dd>
              </div>
              <div>
                <dt className={styles.factTerm}>Events and warnings</dt>
                <dd className={styles.factValue}>
                  {formatNumber(item.eventCount)} events · {openWarnings(item.openWarningCount)}
                </dd>
              </div>
            </dl>
            <div className={styles.actions}>
              <LinkButton href={caseHref(item.id)} appearance="outline" size="small">
                Open case
              </LinkButton>
              <DeleteCaseButton caseId={item.id} reference={item.reference} title={item.title} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <DataTable
      caption="Cases"
      className={styles.table}
      columns={columns}
      rows={ordered}
      getRowId={(row) => row.id}
      sort={sort}
      onSortChange={onSortChange}
    />
  );
}
