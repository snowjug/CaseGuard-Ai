'use client';

import { FORK_CATEGORY_LABELS, type AnalyticsOverview } from '@caseguard/schemas';
import {
  BarChart,
  DataTable,
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  type DataTableColumn,
} from '@caseguard/ui';
import {
  BranchForkRegular,
  CheckmarkCircleRegular,
  ChartMultipleRegular,
  DocumentBulletListRegular,
} from '@fluentui/react-icons';
import { formatNumber, formatPercent, formatProbability } from '../../lib/format';
import { casesText, formatPeriod } from './portfolio-model';
import { useInsightStyles } from './styles';

type TrendRow = AnalyticsOverview['qualityTrend'][number];

const TREND_COLUMNS: readonly DataTableColumn<TrendRow>[] = [
  {
    id: 'period',
    header: 'Month opened',
    rowHeader: true,
    cell: (row) => formatPeriod(row.period),
    sortValue: (row) => row.period,
  },
  {
    id: 'cases',
    header: 'Cases',
    align: 'end',
    cell: (row) => formatNumber(row.caseCount, { maximumFractionDigits: 0 }),
    sortValue: (row) => row.caseCount,
  },
  {
    id: 'quality',
    header: 'Average quality (estimate)',
    align: 'end',
    cell: (row) => formatNumber(row.avgQuality, { maximumFractionDigits: 1 }),
    sortValue: (row) => row.avgQuality,
  },
  {
    id: 'integrity',
    header: 'Average evidence integrity (estimate)',
    align: 'end',
    cell: (row) => formatNumber(row.avgEvidenceIntegrity, { maximumFractionDigits: 1 }),
    sortValue: (row) => row.avgEvidenceIntegrity,
  },
];

export function TrendPanel({ trend }: { trend: AnalyticsOverview['qualityTrend'] }) {
  const styles = useInsightStyles();
  const plotted = trend.filter((row) => row.avgQuality !== null);
  const everyBucketIsOneCase = trend.length > 0 && trend.every((row) => row.caseCount === 1);
  return (
    <Panel
      title="Quality over time"
      description="Average Case Quality Index of the cases opened in each month."
      help="Each bar averages the Case Quality Index of the analysed cases opened in that month. The index is an estimate that focuses a human review; it is not a rating of a person. With only a few cases in a month, a bar is that case's own score rather than a trend."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      {trend.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ChartMultipleRegular />}
          title="No quality scores yet"
          description="Scores appear here once cases have been analysed."
        />
      ) : (
        <>
          {everyBucketIsOneCase ? (
            <Notice variant="warning" compact title="Individual cases, not a trend">
              Every month holds a single case, so each bar is that case's own estimate.
            </Notice>
          ) : null}
          <BarChart
            title="Average Case Quality Index by month opened (estimates)"
            orientation="vertical"
            max={100}
            valueLabel="Average quality (estimate)"
            valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 1 })}
            data={plotted.map((row) => ({
              key: row.period,
              label: formatPeriod(row.period),
              value: row.avgQuality ?? 0,
              note: casesText(row.caseCount),
            }))}
          />
          <div className={styles.tableWrap}>
            <DataTable
              caption="Quality by month opened"
              columns={TREND_COLUMNS}
              rows={trend}
              getRowId={(row) => row.period}
              dense
            />
          </div>
        </>
      )}
    </Panel>
  );
}

export function ForkCategoriesPanel({
  categories,
}: {
  categories: AnalyticsOverview['forkCategories'];
}) {
  const total = categories.reduce((sum, row) => sum + row.count, 0);
  return (
    <Panel
      title="Decision-fork categories"
      description="Where investigations most often had a better move available."
      help="A decision fork is a moment where a safer or shorter step was available, found by comparing each real step with the alternatives known at that time. Each fork gets one primary category. The counts show patterns in processes, not in people."
    >
      {categories.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<BranchForkRegular />}
          title="No decision forks found"
          description="The analysed cases show no moment where a clearly better step was available."
        />
      ) : (
        <BarChart
          title={`Decision forks by category (${total} in total)`}
          valueLabel="Forks"
          valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
          data={categories.map((row) => ({
            key: row.category,
            label: FORK_CATEGORY_LABELS[row.category],
            value: row.count,
            note: `${formatProbability(row.share, 0)} of all forks`,
          }))}
        />
      )}
    </Panel>
  );
}

export function MissingEvidencePanel({ items }: { items: AnalyticsOverview['missingEvidence'] }) {
  return (
    <Panel
      title="Evidence most often still missing"
      description="Requirements not yet collected when the analysed cases ended."
      help="Counts the analysed cases in which an evidence requirement from the knowledge pack was still missing at the end. Frequent gaps point to a missing step in a process or a missing skill, not to a person."
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title="No evidence gap found"
          description="Every evidence requirement was collected in the analysed cases, or none was required."
        />
      ) : (
        <BarChart
          title="Cases in which an evidence requirement was still missing"
          valueLabel="Cases"
          valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
          data={items.map((row) => ({
            key: row.requirementId,
            label: row.label,
            value: row.count,
          }))}
        />
      )}
    </Panel>
  );
}

export function EffortPatternsPanel({
  patterns,
}: {
  patterns: AnalyticsOverview['avoidableEffortPatterns'];
}) {
  return (
    <Panel
      title="Avoidable-effort patterns"
      description="Which kinds of effort a better-sequenced investigation could most often have saved."
      help="Average share of each effort component that a simulated, better-sequenced path would have avoided, over the cases that have one. It compares the real path with a simulated what-if, so every figure is an estimate and never a measurement."
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </>
      }
    >
      {patterns.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<DocumentBulletListRegular />}
          title="No avoidable-effort estimate yet"
          description="It needs an analysed case with a decision fork and a valid simulated path."
        />
      ) : (
        <BarChart
          title="Average avoidable share of each effort component (estimates)"
          max={100}
          valueLabel="Average avoidable share"
          valueFormat={(value) => formatPercent(value, 0)}
          data={patterns.map((row) => ({
            key: row.component,
            label: row.label,
            value: row.avgAvoidablePct,
            tone: 'simulated',
            note: casesText(row.caseCount),
          }))}
        />
      )}
    </Panel>
  );
}

export function AssumptionsPanel({
  items,
}: {
  items: AnalyticsOverview['frequentUnsupportedAssumptions'];
}) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Most frequent unsupported assumptions"
      description="Statements presented as established that no diagnostic evidence supported."
      help="Only the kind of statement is shown (a knowledge-pack label), never the text of a case or who wrote it."
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title="No unsupported assumption found"
          description="No statement in the analysed cases was presented as fact without supporting evidence."
        />
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.subject} className={styles.item}>
              <div className={styles.itemHead}>
                <p className={styles.itemTitle}>{item.subject}</p>
              </div>
              <p className={styles.meta}>
                Seen {item.count} {item.count === 1 ? 'time' : 'times'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
