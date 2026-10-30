'use client';

import {
  METRIC_DEFINITIONS,
  type AvoidableEffortComponent,
  type MetricCard as MetricCardModel,
  type MetricEstimate,
} from '@caseguard/schemas';
import {
  DataTable,
  DeltaBar,
  EmptyState,
  MetricCard,
  Notice,
  Panel,
  ProvenanceBadge,
  ScoreRing,
  StackedBar,
  type DataTableColumn,
} from '@caseguard/ui';
import { DocumentBulletListRegular } from '@fluentui/react-icons';
import { formatNumber, formatPercent } from '../../lib/format';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { ReadableTable } from './ReadableTable';
import { useInsightStyles } from './styles';

/** The card model the shared `MetricCard` renders, built from one metric estimate of this case (nothing is recomputed). */
export function toCard(metric: MetricEstimate, caseId: string): MetricCardModel {
  return {
    key: metric.key,
    label: metric.label,
    value: metric.value,
    display: metric.display,
    unit: metric.unit,
    status: metric.status,
    trend: null,
    definition: metric.definition,
    formula: METRIC_DEFINITIONS[metric.key].formula,
    range:
      metric.low !== null && metric.high !== null ? { low: metric.low, high: metric.high } : null,
    estimated: metric.estimated,
    synthetic: metric.synthetic,
    evidenceLink: null,
    caseId,
  };
}

const CONFIDENCE = { low: 'Low', medium: 'Medium', high: 'High' } as const;

function MetricDetails({ metric, caseId }: { metric: MetricEstimate; caseId: string }) {
  const styles = useInsightStyles();
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>How this is calculated</summary>
      <div className={styles.detailsBody}>
        <p className={styles.meta}>Confidence in the estimate: {CONFIDENCE[metric.confidence]}</p>
        <ClampedText text={metric.method} lines={3} label={`method of ${metric.label}`} />
        {metric.assumptions.length > 0 ? (
          <>
            <p className={styles.itemTitle}>Assumptions</p>
            <ul className={styles.bullets}>
              {metric.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </>
        ) : null}
        {metric.contributors.length > 0 ? (
          <>
            <p className={styles.itemTitle}>What contributes</p>
            <ul className={styles.list}>
              {metric.contributors.map((contributor) => (
                <li key={contributor.label} className={styles.detailsBody}>
                  <p className={styles.text}>
                    <span className={styles.strong}>{contributor.label}</span>:{' '}
                    {formatNumber(contributor.value, { maximumFractionDigits: 1 })}{' '}
                    {contributor.unit}
                    {contributor.share !== null
                      ? ` (${formatNumber(contributor.share * 100, { maximumFractionDigits: 0 })}% of the total)`
                      : ''}
                  </p>
                  <EvidenceLinkList
                    caseId={caseId}
                    links={contributor.evidence}
                    label={`Evidence for ${contributor.label}`}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  );
}

type ComponentRow = AvoidableEffortComponent;

const COMPONENT_COLUMNS: readonly DataTableColumn<ComponentRow>[] = [
  {
    id: 'component',
    header: 'Effort component',
    rowHeader: true,
    cell: (row) => row.label,
    sortValue: (row) => row.label,
  },
  {
    id: 'actual',
    header: 'Actual (estimated)',
    align: 'end',
    cell: (row) => `${formatNumber(row.total, { maximumFractionDigits: 0 })} ${row.unit}`,
    sortValue: (row) => row.total,
  },
  {
    id: 'avoidable',
    header: 'Avoidable (estimated)',
    align: 'end',
    cell: (row) => `${formatNumber(row.avoidable, { maximumFractionDigits: 0 })} ${row.unit}`,
    sortValue: (row) => row.avoidable,
  },
  {
    id: 'share',
    header: 'Avoidable share',
    align: 'end',
    cell: (row) => formatPercent(row.avoidablePct, 0),
    sortValue: (row) => row.avoidablePct,
  },
  {
    id: 'weight',
    header: 'Weight in the estimate',
    align: 'end',
    cell: (row) => formatPercent(row.weight * 100, 0),
    sortValue: (row) => row.weight,
  },
  {
    id: 'assumption',
    header: 'Assumption',
    cell: (row) => (
      <ClampedText text={row.assumption} lines={2} label={`assumption for ${row.label}`} />
    ),
  },
];

const ASE_HELP =
  'Avoidable Support Effort estimates the share of weighted support effort that a better-sequenced investigation could plausibly have avoided. It compares the real path with the best valid simulated path from the earliest decision fork, over several effort components, so it is an estimate built on a what-if. It is shown with its range, contributors and assumptions and is never presented as fact.';

function AseHeadline({ metric, asOf }: { metric: MetricEstimate; asOf: string | null }) {
  const styles = useInsightStyles();
  const comparison = metric.comparison;
  return (
    <Panel
      title="Avoidable Support Effort"
      description="The share of effort a better-sequenced investigation could plausibly have avoided."
      help={ASE_HELP}
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
          {metric.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
    >
      {metric.value === null ? (
        <Notice variant="info" compact title="Not estimated here">
          {asOf
            ? 'Avoidable Support Effort compares the real path with a simulated one and needs the whole record, so it is not estimated inside a time window. Clear the time cursor to see it.'
            : 'It could not be estimated for this case: it needs a decision fork with a valid simulated path.'}
        </Notice>
      ) : (
        <>
          <div className={styles.actions}>
            <ScoreRing
              value={metric.value}
              low={metric.low}
              high={metric.high}
              label="Avoidable Support Effort"
              status={metric.status}
              valueText={formatPercent(metric.value, 0)}
              caption="Estimated"
            />
            <p className={styles.text}>
              <span className={styles.strong}>
                About {formatPercent(metric.value, 0)} of the effort could plausibly have been
                avoided
              </span>{' '}
              (estimate)
              {metric.low !== null && metric.high !== null
                ? `, with a range of ${formatPercent(metric.low, 0)} to ${formatPercent(metric.high, 0)}`
                : ''}
              . Confidence in the estimate: {CONFIDENCE[metric.confidence].toLowerCase()}. Lower is
              better.
            </p>
          </div>
          {comparison && comparison.actual !== null && comparison.counterfactual !== null ? (
            <DeltaBar
              label="Effort still needed (share of the real path)"
              actual={comparison.actual}
              counterfactual={comparison.counterfactual}
              counterfactualLow={comparison.counterfactualLow}
              counterfactualHigh={comparison.counterfactualHigh}
              better="lower"
              format={(value) => formatPercent(value, 0)}
              actualLabel="Real path"
              counterfactualLabel="Simulated path"
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}

function AseMethod({ metric }: { metric: MetricEstimate }) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="How the estimate was calculated"
      description="The method and every assumption it rests on."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      <ClampedText
        text={metric.ase?.method ?? metric.method}
        lines={4}
        label="method of the estimate"
      />
      {metric.assumptions.length > 0 ? (
        <>
          <p className={styles.itemTitle}>Assumptions</p>
          <ul className={styles.bullets}>
            {metric.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className={styles.text}>No assumption is recorded for this estimate.</p>
      )}
    </Panel>
  );
}

function AseBreakdown({ metric, caseId }: { metric: MetricEstimate; caseId: string }) {
  const styles = useInsightStyles();
  const components = metric.ase?.components ?? [];
  if (metric.value === null || (components.length === 0 && metric.contributors.length === 0)) {
    return (
      <Panel title="Contributors and components">
        <EmptyState
          compact
          headingLevel={3}
          icon={<DocumentBulletListRegular />}
          title="No breakdown to show"
          description="Contributors and components appear when Avoidable Support Effort can be estimated."
        />
      </Panel>
    );
  }
  return (
    <Panel
      title="Contributors and components"
      description="Which kinds of effort make up the estimate, with the evidence behind each."
      help="Contributors are the effort components ranked by how many percentage points each adds to the estimate. The table lists every component with its actual and avoidable amount, its share and its weight."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      {metric.contributors.length > 0 ? (
        <>
          <StackedBar
            title="Where the avoidable effort comes from (percentage points)"
            valueLabel="Percentage points"
            valueFormat={(value) => `${formatNumber(value, { maximumFractionDigits: 1 })} points`}
            segments={metric.contributors.map((contributor) => ({
              key: contributor.label,
              label: contributor.label,
              value: contributor.value,
            }))}
          />
          <ul className={styles.list} aria-label="Main contributors">
            {metric.contributors.map((contributor) => (
              <li key={contributor.label} className={styles.item}>
                <p className={styles.itemTitle}>{contributor.label}</p>
                <p className={styles.text}>
                  {formatNumber(contributor.value, { maximumFractionDigits: 1 })} {contributor.unit}
                  {contributor.share !== null
                    ? `, ${formatNumber(contributor.share * 100, { maximumFractionDigits: 0 })}% of the estimate`
                    : ''}
                </p>
                <EvidenceLinkList
                  caseId={caseId}
                  links={contributor.evidence}
                  label={`Evidence for ${contributor.label}`}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {components.length > 0 ? (
        <ReadableTable columns={COMPONENT_COLUMNS.length}>
          <DataTable
            caption="Effort components"
            columns={COMPONENT_COLUMNS}
            rows={components}
            getRowId={(row) => row.key}
            dense
          />
        </ReadableTable>
      ) : null}
    </Panel>
  );
}

export interface MetricsViewProps {
  metrics: readonly MetricEstimate[];
  caseId: string;
  asOf: string | null;
}

/** The "Effort and metrics" tab: Avoidable Support Effort in full, then the other estimates with how each was calculated. */
export function MetricsView({ metrics, caseId, asOf }: MetricsViewProps) {
  const styles = useInsightStyles();
  const ase = metrics.find((metric) => metric.key === 'avoidable_support_effort');
  const others = metrics.filter(
    (metric) => metric.key !== 'avoidable_support_effort' && metric.key !== 'case_quality_index',
  );
  return (
    <div className={styles.page}>
      {ase ? (
        <>
          <div className={styles.band}>
            <AseHeadline metric={ase} asOf={asOf} />
            <AseMethod metric={ase} />
          </div>
          <AseBreakdown metric={ase} caseId={caseId} />
        </>
      ) : (
        <EmptyState
          headingLevel={2}
          icon={<DocumentBulletListRegular />}
          title="Avoidable Support Effort is not available"
          description="The analysis did not produce this estimate for the case."
        />
      )}
      {others.length > 0 ? (
        <section className={styles.stack} aria-labelledby="other-metrics">
          <h2 id="other-metrics" className={styles.itemTitle}>
            Other estimates
          </h2>
          <ul
            className={styles.tiles}
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
          >
            {others.map((metric) => (
              <li key={metric.key} className={styles.stack}>
                <MetricCard metric={toCard(metric, caseId)} headingLevel={3} />
                <MetricDetails metric={metric} caseId={caseId} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {others.length > 0 ? (
        <p className={styles.meta}>The Case Quality Index has its own tab.</p>
      ) : null}
    </div>
  );
}
