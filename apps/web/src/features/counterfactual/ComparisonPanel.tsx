'use client';

import type { CounterfactualScenario, DecisionFork, DiagnosticAction } from '@caseguard/schemas';
import {
  DataTable,
  Notice,
  PathComparison,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatNumber,
  formatProbability,
  type DataTableColumn,
  type PathMetricDelta,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
import { LEVEL_LABELS } from '../reasoning/labels';
import {
  METRIC_SPECS,
  comparisonTracks,
  describeImprovement,
  headlineImprovements,
  metricDeltas,
} from './model';
import { TrustPanel } from './TrustPanel';
import { describeTrust } from './trust';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    minHeight: '28px',
    padding: `0 ${cg.space[3]}`,
    borderRadius: cg.radius.pill,
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
    color: cg.tone.simulated.fg,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  list: {
    margin: 0,
    paddingLeft: cg.space[4],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  details: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    padding: `${cg.space[1]} ${cg.space[3]}`,
    backgroundColor: cg.surface,
  },
  summary: {
    cursor: 'pointer',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

function formatRange(row: PathMetricDelta): string {
  if (row.low === null || row.low === undefined || row.high === null || row.high === undefined)
    return '—';
  const format = row.format ?? ((n: number) => formatNumber(n, { maximumFractionDigits: 1 }));
  return `${format(row.low)} to ${format(row.high)}`;
}

const COLUMNS: DataTableColumn<PathMetricDelta>[] = [
  { id: 'label', header: 'Measure', cell: (row) => row.label, rowHeader: true },
  {
    id: 'actual',
    header: 'Actual',
    align: 'end',
    cell: (row) => (row.format ?? String)(row.actual),
  },
  {
    id: 'simulated',
    header: 'Simulated (median)',
    align: 'end',
    cell: (row) => (row.format ?? String)(row.counterfactual),
  },
  { id: 'range', header: 'Simulated range', align: 'end', cell: formatRange },
  {
    id: 'better',
    header: 'Better is',
    cell: (row) => (row.better === 'higher' ? 'Higher' : 'Lower'),
  },
];

export interface ComparisonPanelProps {
  fork: DecisionFork;
  scenario: CounterfactualScenario;
  /** The recorded actions of the case (the actual path is drawn from them). */
  actions: readonly DiagnosticAction[];
}

/**
 * What happened next to what the simulation says would have happened, both measured from the decision instant: the two
 * paths diverging at the fork, ten estimated measures with their ranges, and how much confidence the comparison itself
 * deserves. Simulated and estimated labels are on every number.
 */
export function ComparisonPanel({ fork, scenario, actions }: ComparisonPanelProps) {
  const styles = useStyles();
  const tracks = useMemo(
    () => comparisonTracks(fork, scenario, actions),
    [fork, scenario, actions],
  );
  const deltas = useMemo(() => metricDeltas(scenario), [scenario]);
  const headlines = headlineImprovements(scenario);
  const confidence = scenario.comparisonConfidence;
  const trust = useMemo(() => describeTrust(scenario.quality), [scenario.quality]);
  const countMismatch = tracks.recordedActionCount !== scenario.actualMetrics.actionCount.mid;

  return (
    <div className={styles.stack}>
      <section className={styles.section} aria-label="Summary of the comparison">
        <div className={styles.row}>
          <h3 className={styles.h3}>What would have changed</h3>
          <ProvenanceBadge kind="simulated" />
          <ProvenanceBadge kind="estimated" />
        </div>
        <p className={styles.text}>{scenario.summary}</p>
        {headlines.length > 0 ? (
          <ul className={styles.chips} aria-label="Estimated improvements">
            {headlines.map((line) => (
              <li key={line.key} className={styles.chip}>
                {describeImprovement(line)}
              </li>
            ))}
          </ul>
        ) : null}
        <p className={styles.muted}>
          Estimated from {scenario.rollouts.count} seeded simulations. A diagnosis was reached in{' '}
          {formatProbability(scenario.rollouts.diagnosisReachedShare)} of them, and the single most
          common path accounts for {formatProbability(scenario.rollouts.modalPathShare)}.
        </p>
        <p className={styles.muted}>
          Only the simulated side was generated from what was known at the decision. The recorded
          side is read from the whole record, after the fact, so every measure below sets a
          decision-time estimate against an outcome that is now known.
        </p>
      </section>

      <Notice
        variant="model-estimate"
        title={`Confidence in this comparison: ${LEVEL_LABELS[confidence.level]} (${formatNumber(confidence.score, { maximumFractionDigits: 2 })} of 1)`}
      >
        {confidence.rationale}
      </Notice>

      {trust ? <TrustPanel trust={trust} /> : null}

      <PathComparison
        actual={tracks.actual}
        counterfactual={tracks.counterfactual}
        forkStepId={tracks.forkStepId}
        forkLabel={fork.title}
        metrics={deltas}
        title="The recorded path and the simulated alternative, from the decision moment"
      />
      {countMismatch ? (
        <p className={styles.muted}>
          The recorded track shows {tracks.recordedActionCount} actions; the API counts{' '}
          {formatNumber(scenario.actualMetrics.actionCount.mid, { maximumFractionDigits: 0 })} for
          this path.
        </p>
      ) : null}

      <details className={styles.details}>
        <summary className={styles.summary}>The numbers behind the comparison</summary>
        <DataTable
          caption="Actual and simulated measures"
          columns={COLUMNS}
          rows={deltas}
          getRowId={(row) => row.key}
          dense
        />
      </details>

      {scenario.branchNotes.length > 0 ? (
        <section className={styles.section} aria-label="What could turn out differently">
          <h3 className={styles.h3}>What could turn out differently</h3>
          <p className={styles.muted}>
            Each step has more than one possible result. These are the alternative branches the
            simulation considered, with their estimated probabilities.
          </p>
          <ul className={styles.list}>
            {scenario.branchNotes.map((note) => (
              <li key={`${note.afterStepIndex}-${note.condition}`}>
                After step {note.afterStepIndex + 1}: {note.condition} (
                {formatProbability(note.probability)}, estimate). {note.thenAction}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.section} aria-label="Assumptions">
        <h3 className={styles.h3}>Assumptions ({scenario.assumptions.length})</h3>
        <ul className={styles.list}>
          {scenario.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <p className={styles.muted}>
          <StatusBadge
            status={scenario.validity.valid ? 'productive' : 'unsupported'}
            label={scenario.validity.valid ? 'Valid path' : 'Failed validity checks'}
            size="small"
          />{' '}
          {METRIC_SPECS.length} measures compared · every value is a simulated estimate
        </p>
      </section>
    </div>
  );
}
