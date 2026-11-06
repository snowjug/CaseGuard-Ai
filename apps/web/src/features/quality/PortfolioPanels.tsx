'use client';

import { FORK_CATEGORY_LABELS, type AnalyticsOverview } from '@caseguard/schemas';
import { BarChart, EmptyState, Panel, ProvenanceBadge, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { CircleCheckIcon, GitForkIcon, HourglassIcon, ShieldCheckIcon } from 'lucide-react';
import { formatPercent, formatProbability } from '../../lib/format';
import { useLook } from './look';
import { casesText, formatCount } from './portfolio-model';

const useStyles = makeStyles({
  fill: { height: '100%', boxSizing: 'border-box' },
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyleType: 'none' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    paddingBlock: cg.space[3],
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
  },
});

export function ForkCategoriesPanel({
  categories,
}: {
  categories: AnalyticsOverview['forkCategories'];
}) {
  const styles = useStyles();
  const total = categories.reduce((sum, row) => sum + row.count, 0);
  return (
    <Panel
      title="Where a better step was available"
      description="The kinds of key decision that came up most often."
      help="A key decision (a decision fork) is a moment where a safer or shorter step was available, found by comparing each real step with the alternatives known at that time. Each one gets a single category. The counts show patterns in processes, not in people."
      className={styles.fill}
    >
      {categories.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<GitForkIcon />}
          title="No key decisions found"
          description="The analysed cases show no moment where a clearly better step was available."
        />
      ) : (
        <BarChart
          title={`Key decisions by category (${total} in total)`}
          valueLabel="Key decisions"
          valueFormat={formatCount}
          data={categories.map((row) => ({
            key: row.category,
            label: FORK_CATEGORY_LABELS[row.category],
            value: row.count,
            note: `${formatProbability(row.share, 0)} of all key decisions`,
          }))}
        />
      )}
    </Panel>
  );
}

export function MissingEvidencePanel({ items }: { items: AnalyticsOverview['missingEvidence'] }) {
  const styles = useStyles();
  return (
    <Panel
      title="Evidence most often missing"
      description="Requirements not yet collected when the analysed cases ended."
      help="Counts the analysed cases in which an evidence requirement from the knowledge pack was still missing at the end. Frequent gaps point to a missing step in a process or a missing skill, not to a person."
      className={styles.fill}
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CircleCheckIcon />}
          title="No evidence gap found"
          description="Every evidence requirement was collected in the analysed cases, or none was required."
        />
      ) : (
        <BarChart
          title="Cases in which an evidence requirement was still missing"
          valueLabel="Cases"
          valueFormat={formatCount}
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
  const styles = useStyles();
  return (
    <Panel
      title="Where effort could be saved"
      description="Which kinds of effort a better-sequenced investigation could most often have saved."
      help="Average share of each effort component that a simulated, better-sequenced path would have avoided, over the cases that have one. It compares the real path with a simulated what-if, so every figure is an estimate and never a measurement."
      className={styles.fill}
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
          icon={<HourglassIcon />}
          title="No estimate of time saved yet"
          description="It needs an analysed case with a key decision and a valid simulated path."
        />
      ) : (
        <BarChart
          title="Average share of each effort component that could have been saved (estimates)"
          max={100}
          valueLabel="Average share saved"
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
  const styles = useStyles();
  const look = useLook();
  return (
    <Panel
      title="Assumptions without evidence"
      description="Statements presented as established that no diagnostic evidence supported."
      help="Only the kind of statement is shown (a knowledge-pack label), never the text of a case or who wrote it."
      className={styles.fill}
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ShieldCheckIcon />}
          title="No unsupported assumption found"
          description="No statement in the analysed cases was presented as fact without supporting evidence."
        />
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.subject} className={styles.item}>
              <p className={look.title}>{item.subject}</p>
              <p className={look.meta}>
                Seen {item.count} {item.count === 1 ? 'time' : 'times'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
