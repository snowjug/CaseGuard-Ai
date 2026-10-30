'use client';

import type { Hypothesis } from '@caseguard/schemas';
import { MODEL_ESTIMATE_NOTICE } from '@caseguard/schemas';
import {
  EmptyState,
  LineChart,
  Notice,
  Panel,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { Checkbox, makeStyles, tokens } from '@fluentui/react-components';
import { LightbulbRegular } from '@fluentui/react-icons';
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
  'Each line is the model-estimated confidence in one explanation after every new piece of evidence. The shaded band is the model’s 10–90% range for the selected hypothesis. Numbered markers are the engineer’s actions and the decision forks, listed under the chart. Move the time cursor and the chart stops at that instant: nothing later is drawn.';

export interface ConfidencePanelProps {
  hypotheses: readonly Hypothesis[];
  markers: readonly ChartMarker[];
  /** The hypothesis whose band is drawn. */
  focusId: string | null;
  showAll: boolean;
  onShowAllChange: (value: boolean) => void;
  /** The boundary the server answered for (its own `asOf`); null for the whole record. */
  asOf?: string | null;
}

/** Confidence over time for the competing hypotheses, with the selected one's range and the actions marked. */
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
      description="How the model’s confidence in each explanation moved as evidence arrived."
      help={HELP}
      accent="hypothesis"
    >
      <Notice variant="model-estimate" compact title={null}>
        {MODEL_ESTIMATE_NOTICE}
      </Notice>
      {asOf !== null ? (
        <p className={styles.hint}>
          Drawn up to {formatDateTimeUtc(asOf)}, the boundary the server answered for. Nothing later
          is drawn.
        </p>
      ) : null}
      {hypotheses.length === 0 ? (
        <EmptyState
          compact
          icon={<LightbulbRegular />}
          title="Nothing to chart yet"
          description="No hypothesis has been scored at this time."
        />
      ) : (
        <>
          <LineChart
            title="Model-estimated confidence in each hypothesis over time"
            hideTitle
            series={series}
            events={events}
            yDomain={[0, 1]}
            yFormat={(value) => formatProbability(value)}
            bandLabel="Model-estimated range (10–90%) of the selected hypothesis"
            height={300}
          />
          <div className={styles.tools}>
            <Checkbox
              checked={showAll}
              onChange={(_event, data) => onShowAllChange(data.checked === true)}
              label={`Show every hypothesis (${hypotheses.length})`}
            />
            <p className={styles.hint}>
              {showAll || hidden === 0
                ? `Showing all ${charted.length} hypotheses.`
                : `Showing the ${charted.length} that reached at least ${formatProbability(CONTENDER_THRESHOLD)} at some point; ${hidden} stayed below.`}
            </p>
          </div>
        </>
      )}
    </Panel>
  );
}
