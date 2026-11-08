'use client';

import {
  METRIC_DEFINITIONS,
  type AvoidableEffortComponent,
  type MetricCard as MetricCardModel,
  type MetricEstimate,
} from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  BentoGrid,
  BentoItem,
  BlurFade,
  DataTable,
  DeltaBar,
  EmptyState,
  MetricCard,
  NumberTicker,
  Panel,
  ProvenanceBadge,
  StackedBar,
  StatusBadge,
  cg,
  type BadgeStatus,
  type DataTableColumn,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ListChecksIcon } from 'lucide-react';
import { formatNumber, formatPercent } from '../../lib/format';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { useLook } from './look';
import { ReadableTable } from './ReadableTable';

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

const STATUS: Record<MetricEstimate['status'], { status: BadgeStatus; label: string }> = {
  good: { status: 'productive', label: 'Good' },
  watch: { status: 'uncertain', label: 'Fair' },
  poor: { status: 'unsupported', label: 'Poor' },
  unknown: { status: 'missing', label: 'Not enough data' },
};

const useStyles = makeStyles({
  fill: { height: '100%', boxSizing: 'border-box' },
  big: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[4]}`,
  },
  number: {
    color: cg.text,
    fontSize: tokens.fontSizeHero900,
    lineHeight: '1',
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
  },
  cards: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
  },
  card: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  contributors: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  contributor: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    paddingBlock: cg.space[3],
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
  },
  detailList: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
});

function MetricDetails({ metric, caseId }: { metric: MetricEstimate; caseId: string }) {
  const look = useLook();
  const styles = useStyles();
  return (
    <div className={look.stack}>
      <p className={look.meta}>Confidence in the estimate: {CONFIDENCE[metric.confidence]}</p>
      <ClampedText text={metric.method} lines={3} label={`method of ${metric.label}`} />
      {metric.assumptions.length > 0 ? (
        <div className={look.tight}>
          <p className={look.title}>Assumptions</p>
          <ul className={look.bullets}>
            {metric.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {metric.contributors.length > 0 ? (
        <div className={look.tight}>
          <p className={look.title}>What contributes</p>
          <ul className={styles.detailList}>
            {metric.contributors.map((contributor) => (
              <li key={contributor.label} className={look.tight}>
                <p className={look.text}>
                  <span className={look.strong}>{contributor.label}</span>:{' '}
                  {formatNumber(contributor.value, { maximumFractionDigits: 1 })} {contributor.unit}
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
        </div>
      ) : null}
    </div>
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
    header: 'Could have been saved (estimated)',
    align: 'end',
    cell: (row) => `${formatNumber(row.avoidable, { maximumFractionDigits: 0 })} ${row.unit}`,
    sortValue: (row) => row.avoidable,
  },
  {
    id: 'share',
    header: 'Share saved',
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
  'Time that could have been saved estimates the share of weighted support effort that a better-sequenced investigation could plausibly have avoided. It compares the real path with the best valid simulated path from the earliest key decision, over several effort components, so it is an estimate built on a what-if. It is shown with its range, contributors and assumptions and is never presented as fact.';

function AseHeadline({ metric, asOf }: { metric: MetricEstimate; asOf: string | null }) {
  const styles = useStyles();
  const look = useLook();
  const comparison = metric.comparison;
  const status = STATUS[metric.status];
  return (
    <Panel
      title="Time that could have been saved"
      description="The share of effort a better-sequenced investigation could plausibly have avoided."
      help={ASE_HELP}
      className={styles.fill}
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
          {metric.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
    >
      {metric.value === null ? (
        <div className={look.tight}>
          <p className={look.title}>Not estimated here</p>
          <p className={look.text}>
            {asOf
              ? 'Time that could have been saved compares the real path with a simulated one and needs the whole record, so it is not estimated inside a time window. Clear the time cursor to see it.'
              : 'It could not be estimated for this case: it needs a key decision with a valid simulated path.'}
          </p>
        </div>
      ) : (
        <>
          <div className={styles.big}>
            <span className={styles.number}>
              <NumberTicker value={metric.value} format={(value) => formatPercent(value, 0)} />
            </span>
            <StatusBadge status={status.status} label={status.label} />
          </div>
          <p className={look.text}>
            <span className={look.strong}>
              About {formatPercent(metric.value, 0)} of the effort could plausibly have been avoided
            </span>{' '}
            (estimate)
            {metric.low !== null && metric.high !== null
              ? `, with a range of ${formatPercent(metric.low, 0)} to ${formatPercent(metric.high, 0)}`
              : ''}
            . Confidence in the estimate: {CONFIDENCE[metric.confidence].toLowerCase()}. Lower is
            better.
          </p>
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
      <Accordion>
        <AccordionItem
          title="How the estimate was calculated"
          subtitle="The method and every assumption it rests on."
        >
          <div className={look.stack}>
            <ClampedText
              text={metric.ase?.method ?? metric.method}
              lines={4}
              label="method of the estimate"
            />
            {metric.assumptions.length > 0 ? (
              <div className={look.tight}>
                <p className={look.title}>Assumptions</p>
                <ul className={look.bullets}>
                  {metric.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className={look.text}>No assumption is recorded for this estimate.</p>
            )}
          </div>
        </AccordionItem>
      </Accordion>
    </Panel>
  );
}

function AseBreakdown({ metric, caseId }: { metric: MetricEstimate; caseId: string }) {
  const styles = useStyles();
  const look = useLook();
  const components = metric.ase?.components ?? [];
  if (components.length === 0 && metric.contributors.length === 0) {
    return (
      <Panel title="What the estimate is made of" className={styles.fill}>
        <EmptyState
          compact
          headingLevel={3}
          icon={<ListChecksIcon />}
          title="No breakdown to show"
          description="The breakdown appears when the time that could have been saved can be estimated."
        />
      </Panel>
    );
  }
  return (
    <Panel
      title="What the estimate is made of"
      description="Which kinds of effort make up the estimate, with the evidence behind each."
      help="Contributors are the effort components ranked by how many percentage points each adds to the estimate. The table lists every component with its actual and avoidable amount, its share and its weight."
      actions={<ProvenanceBadge kind="estimated" />}
      className={styles.fill}
    >
      {metric.contributors.length > 0 ? (
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
      ) : null}
      {metric.contributors.length > 0 || components.length > 0 ? (
        <Accordion>
          {metric.contributors.length > 0 ? (
            <AccordionItem
              title="Show what each part rests on"
              subtitle="The evidence behind each contributor"
            >
              <ul className={styles.contributors} aria-label="Main contributors">
                {metric.contributors.map((contributor) => (
                  <li key={contributor.label} className={styles.contributor}>
                    <p className={look.title}>{contributor.label}</p>
                    <p className={look.text}>
                      {formatNumber(contributor.value, { maximumFractionDigits: 1 })}{' '}
                      {contributor.unit}
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
            </AccordionItem>
          ) : null}
          {components.length > 0 ? (
            <AccordionItem
              title="Show every effort component"
              subtitle="Actual and avoidable amounts, share and weight"
            >
              <ReadableTable columns={COMPONENT_COLUMNS.length}>
                <DataTable
                  caption="Effort components"
                  columns={COMPONENT_COLUMNS}
                  rows={components}
                  getRowId={(row) => row.key}
                  dense
                />
              </ReadableTable>
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
    </Panel>
  );
}

export interface MetricsViewProps {
  metrics: readonly MetricEstimate[];
  caseId: string;
  asOf: string | null;
}

/**
 * The "Effort and metrics" tab: the time that could have been saved in full (what it is, what it is made of and how it
 * was calculated), then the other estimates with how each was calculated.
 */
export function MetricsView({ metrics, caseId, asOf }: MetricsViewProps) {
  const styles = useStyles();
  const look = useLook();
  const ase = metrics.find((metric) => metric.key === 'avoidable_support_effort');
  const others = metrics.filter(
    (metric) => metric.key !== 'avoidable_support_effort' && metric.key !== 'case_quality_index',
  );
  return (
    <div className={look.page}>
      {ase ? (
        <BentoGrid>
          <BentoItem span={12} spanLg={ase.value === null ? 12 : 7}>
            <BlurFade className={styles.fill}>
              <AseHeadline metric={ase} asOf={asOf} />
            </BlurFade>
          </BentoItem>
          {ase.value === null ? null : (
            <BentoItem span={12} spanLg={5}>
              <BlurFade index={1} className={styles.fill}>
                <AseBreakdown metric={ase} caseId={caseId} />
              </BlurFade>
            </BentoItem>
          )}
        </BentoGrid>
      ) : (
        <EmptyState
          headingLevel={2}
          icon={<ListChecksIcon />}
          title="Time that could have been saved is not available"
          description="The analysis did not produce this estimate for the case."
        />
      )}
      {others.length > 0 ? (
        <section className={look.stack} aria-labelledby="other-metrics">
          <h2 id="other-metrics" className={look.heading}>
            Other estimates
          </h2>
          <ul className={styles.cards}>
            {others.map((metric) => (
              <li key={metric.key} className={styles.card}>
                <MetricCard metric={toCard(metric, caseId)} headingLevel={3} />
                <Accordion>
                  <AccordionItem title="How this is calculated" headingLevel={4}>
                    <MetricDetails metric={metric} caseId={caseId} />
                  </AccordionItem>
                </Accordion>
              </li>
            ))}
          </ul>
          <p className={look.meta}>The Case Quality Index is the score at the top of this page.</p>
        </section>
      ) : null}
    </div>
  );
}
