'use client';

import type { Hypothesis } from '@caseguard/schemas';
import {
  EmptyState,
  LineChart,
  Panel,
  ProvenanceBadge,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { Checkbox, makeStyles, tokens } from '@fluentui/react-components';
import { LightbulbIcon } from 'lucide-react';
import { useMemo } from 'react';
import { buildSeries, chartedHypotheses, CONTENDER_THRESHOLD, type ChartMarker } from './model';

const useStyles = makeStyles({
  tools: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

const HELP =
  'Each line is the model-estimated confidence in one possible cause after every new piece of evidence. These are model estimates from an authored knowledge pack, not statistical truth. The shaded band is the model’s 10–90% range for the cause you opened, or for the leading one. Numbered markers are the engineer’s actions and the key decisions, listed under the chart. Move the time cursor and the chart stops at that instant: nothing later is drawn.';

export interface ConfidencePanelProps {
  hypotheses: readonly Hypothesis[];
  markers: readonly ChartMarker[];
  /** The cause whose band is drawn. */
  focusId: string | null;
  showAll: boolean;
  onShowAllChange: (value: boolean) => void;
  /** The boundary the server answered for (its own `asOf`); null for the whole record. */
  asOf?: string | null;
}

/** Confidence over time for the competing possible causes, with the focused one's range and the actions marked. */
export function ConfidencePanel({
  hypotheses,
  markers,
  focusId,
  showAll,
  onShowAllChange,
  asOf = null,
}: ConfidencePanelProps) {
  const styles = useStyles();
  const charted = useMemo(
    () => chartedHypotheses(hypotheses, focusId, showAll),
    [hypotheses, focusId, showAll],
  );
  const series = useMemo(() => buildSeries(charted, focusId), [charted, focusId]);
  const events = useMemo(() => markers.map(({ x, label }) => ({ x, label })), [markers]);
  const hidden = hypotheses.length - charted.length;

  return (
    <Panel
      title="Confidence over time"
      description="How the model’s confidence in each possible cause moved as evidence arrived."
      help={HELP}
      actions={<ProvenanceBadge kind="estimated" />}
    >
      {asOf !== null ? (
        <p className={styles.hint}>
          Drawn up to {formatDateTimeUtc(asOf)}, the boundary the server answered for. Nothing later
          is drawn.
        </p>
      ) : null}
      {hypotheses.length === 0 ? (
        <EmptyState
          compact
          icon={<LightbulbIcon />}
          title="Nothing to chart yet"
          description="No possible cause has been scored at this time."
        />
      ) : (
        <>
          <LineChart
            title="Model-estimated confidence in each possible cause over time"
            hideTitle
            series={series}
            events={events}
            yDomain={[0, 1]}
            yFormat={(value) => formatProbability(value)}
            bandLabel="Model-estimated range (10–90%) of the focused cause"
            height={260}
          />
          <div className={styles.tools}>
            <Checkbox
              checked={showAll}
              onChange={(_event, data) => onShowAllChange(data.checked === true)}
              label={`Show every possible cause (${hypotheses.length})`}
            />
            <p className={styles.hint}>
              {showAll || hidden === 0
                ? `Showing all ${charted.length} possible causes.`
                : `Showing the ${charted.length} that reached at least ${formatProbability(CONTENDER_THRESHOLD)} at some point; ${hidden} stayed below.`}
            </p>
          </div>
        </>
      )}
    </Panel>
  );
}
