'use client';

import type { CaseSummary } from '@caseguard/schemas';
import {
  ButtonLink,
  Card,
  DataTable,
  ProvenanceBadge,
  RelativeTime,
  StatusBadge,
  UiLink,
  VisuallyHidden,
  cg,
  formatNumber,
  formatPercent,
  formatProbability,
  sortRows,
  type DataTableColumn,
  type SortState,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
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
    minWidth: '220px',
    padding: `${cg.space[1]} 0`,
    '@media (max-width: 1279px)': { minWidth: 0 },
  },
  // The table primitive lays columns out equally and never narrower than its content; automatic layout honours the
  // column widths set below and shrinks the free columns to fit.
  table: { '& table': { tableLayout: 'auto', minWidth: 'min-content' } },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    width: 'fit-content',
    minHeight: '24px',
    color: cg.tone.brand.fg,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  title: {
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightMedium,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
    maxWidth: '52ch',
  },
  meta: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[1] },
  number: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
  muted: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  stack: { display: 'flex', flexDirection: 'column', gap: '2px' },
  actions: { display: 'flex', alignItems: 'center', gap: cg.space[1], flexWrap: 'wrap' },
  cards: {
    display: 'grid',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    height: '100%',
    boxSizing: 'border-box',
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

const score = (value: number | null): string =>
  value === null ? '—' : formatNumber(value, { maximumFractionDigits: 0 });

/** Where a case opens: the review once there is one, the case itself until then. */
const openHref = (item: CaseSummary): string =>
  caseHref(item.id, item.analysisState === 'analyzed' ? 'review' : undefined);

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

/** What the analysis found out, in one muted line: the likeliest cause and how many warnings are open. */
function Finding({ item }: { item: CaseSummary }) {
  const styles = useStyles();
  const warnings = `${item.openWarningCount} open ${item.openWarningCount === 1 ? 'warning' : 'warnings'}`;
  return (
    <span className={styles.muted}>
      {item.leadingHypothesis
        ? `${item.leadingHypothesis.name} (${formatProbability(item.leadingHypothesis.confidence)}, estimated) · `
        : ''}
      {warnings}
    </span>
  );
}

export interface CaseRowsProps {
  rows: readonly CaseSummary[];
  sort: SortState;
  onSortChange: (sort: SortState | null) => void;
  /** Cards instead of a table (narrow screens). */
  compact: boolean;
}

/** The loaded cases as a sortable, borderless table, or as cards on narrow screens. */
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
            <UiLink href={openHref(row)} className={styles.link}>
              {row.reference}
            </UiLink>
            <span className={styles.title} title={row.title}>
              {row.title}
            </span>
            <span className={styles.meta}>{caseMeta(row)}</span>
            <Finding item={row} />
          </div>
        ),
      },
      {
        id: 'quality',
        header: 'Score (est.)',
        align: 'end',
        width: '96px',
        sortValue: (row) => sortValueOf(row, 'quality'),
        cell: (row) =>
          row.qualityIndex === null ? (
            <span className={styles.muted}>Not available</span>
          ) : (
            <span className={styles.number} title="Estimated score out of 100">
              {score(row.qualityIndex)}
              <span className={styles.muted}> / 100</span>
            </span>
          ),
      },
      {
        id: 'analysis',
        header: 'Status',
        width: '120px',
        cell: (row) => <AnalysisBadges item={row} />,
      },
      {
        id: 'effort',
        header: 'Could have been saved (est.)',
        align: 'end',
        width: '132px',
        sortValue: (row) => sortValueOf(row, 'effort'),
        cell: (row) =>
          row.avoidableEffortPct === null ? (
            <span className={styles.muted}>Not available</span>
          ) : (
            <span className={styles.number}>{formatPercent(row.avoidableEffortPct, 0)}</span>
          ),
      },
      {
        id: 'opened',
        header: 'Opened',
        width: '120px',
        sortValue: (row) => sortValueOf(row, 'opened'),
        cell: (row) => (
          <div className={styles.stack}>
            <RelativeTime value={row.openedAt} />
            <span className={styles.muted}>{countOf(row.eventCount, 'event')}</span>
          </div>
        ),
      },
      {
        id: 'actions',
        header: <VisuallyHidden>Actions</VisuallyHidden>,
        width: '112px',
        cell: (row) => (
          <div className={styles.actions}>
            <ButtonLink href={openHref(row)} variant="ghost" size="sm">
              Open
            </ButtonLink>
            <DeleteCaseButton caseId={row.id} reference={row.reference} title={row.title} />
          </div>
        ),
      },
    ],
    [styles],
  );

  // Open warnings and events are not columns of their own (they sit in the case cell and under the date), but they
  // stay sort options.
  const sortColumns = useMemo<readonly DataTableColumn<CaseSummary>[]>(
    () => [
      ...columns,
      {
        id: 'warnings',
        header: 'Open warnings',
        cell: () => null,
        sortValue: (row) => sortValueOf(row, 'warnings'),
      },
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
          <li key={item.id}>
            <Card as="div" padding="md" className={styles.card}>
              <div className={styles.caseCell}>
                <UiLink href={openHref(item)} className={styles.link}>
                  {item.reference}
                </UiLink>
                <span className={styles.title}>{item.title}</span>
                <span className={styles.meta}>
                  {caseMeta(item)} · opened <RelativeTime value={item.openedAt} />
                </span>
              </div>
              <AnalysisBadges item={item} />
              <dl className={styles.facts}>
                <div>
                  <dt className={styles.factTerm}>Score (estimated)</dt>
                  <dd className={styles.factValue}>
                    {item.qualityIndex === null
                      ? 'Not available'
                      : `${score(item.qualityIndex)} / 100`}
                  </dd>
                </div>
                <div>
                  <dt className={styles.factTerm}>Could have been saved (estimated)</dt>
                  <dd className={styles.factValue}>
                    {item.avoidableEffortPct === null
                      ? 'Not available'
                      : formatPercent(item.avoidableEffortPct, 0)}
                  </dd>
                </div>
                <div>
                  <dt className={styles.factTerm}>Likeliest cause</dt>
                  <dd className={styles.factValue}>
                    {item.leadingHypothesis
                      ? `${item.leadingHypothesis.name} (${formatProbability(item.leadingHypothesis.confidence)}, estimated)`
                      : 'Not available'}
                  </dd>
                </div>
                <div>
                  <dt className={styles.factTerm}>Events and warnings</dt>
                  <dd className={styles.factValue}>
                    {formatNumber(item.eventCount)} events · {item.openWarningCount} open{' '}
                    {item.openWarningCount === 1 ? 'warning' : 'warnings'}
                  </dd>
                </div>
              </dl>
              <div className={styles.actions}>
                <ButtonLink href={openHref(item)} variant="secondary" size="sm">
                  {item.analysisState === 'analyzed' ? 'Open review' : 'Open case'}
                </ButtonLink>
                <DeleteCaseButton caseId={item.id} reference={item.reference} title={item.title} />
              </div>
            </Card>
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
