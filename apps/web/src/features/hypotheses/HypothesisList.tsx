'use client';

import type { Hypothesis } from '@caseguard/schemas';
import { Panel, RangeBar, StatusBadge, cg, formatNumber, formatProbability } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { HYPOTHESIS_STATUS_BADGES } from '../reasoning/labels';
import { latestPoint } from './model';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    padding: `${cg.space[2]} ${cg.space[3]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    cursor: 'pointer',
    ':hover': { border: `1px solid ${cg.borderControl}` },
  },
  selected: {
    border: `1px solid ${cg.tone.hypothesis.solid}`,
    backgroundColor: cg.tone.hypothesis.tint,
    boxShadow: `inset 4px 0 0 ${cg.tone.hypothesis.solid}`,
  },
  pick: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    width: '100%',
    boxSizing: 'border-box',
    textAlign: 'start',
    padding: `${cg.space[1]} 0`,
    border: 'none',
    background: 'none',
    color: cg.text,
    font: 'inherit',
    cursor: 'pointer',
    minHeight: '32px',
    borderRadius: cg.radius.sm,
    // The button stretches over the whole card, so a pointer can pick it anywhere while the button stays the one stop
    // for keyboards and screen readers.
    '::after': { content: '""', position: 'absolute', inset: 0, borderRadius: cg.radius.md },
    ':focus-visible': { outline: `3px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  rank: {
    minWidth: '22px',
    fontVariantNumeric: 'tabular-nums',
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
  },
  name: {
    flex: '1 1 160px',
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
});

export interface HypothesisListProps {
  /** Ranked by confidence at the boundary (the API already ranks them). */
  hypotheses: readonly Hypothesis[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Every competing hypothesis, ranked, each with its confidence range. Choosing one opens its detail. */
export function HypothesisList({ hypotheses, selectedId, onSelect }: HypothesisListProps) {
  const styles = useStyles();
  return (
    <Panel
      title="Competing hypotheses"
      description="Ranked by model-estimated confidence at this time. Choose one to see its evidence."
      help="The Arena keeps every explanation alive instead of picking a root cause early. Confidence is a model estimate from an authored knowledge pack, shown with its range; it is not a statistical probability."
    >
      <ol className={styles.list} aria-label="Hypotheses ranked by confidence">
        {hypotheses.map((hypothesis, index) => {
          const badge = HYPOTHESIS_STATUS_BADGES[hypothesis.currentStatus];
          const delta = latestPoint(hypothesis)?.delta ?? 0;
          const selected = hypothesis.id === selectedId;
          return (
            <li
              key={hypothesis.id}
              className={mergeClasses(styles.item, selected && styles.selected)}
            >
              <button
                type="button"
                className={styles.pick}
                aria-pressed={selected}
                onClick={() => onSelect(hypothesis.id)}
              >
                <span className={styles.rank} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.name}>{hypothesis.name}</span>
                <StatusBadge status={badge.status} label={badge.label} size="small" />
              </button>
              <RangeBar
                value={hypothesis.currentConfidence * 100}
                low={hypothesis.currentLow * 100}
                high={hypothesis.currentHigh * 100}
                label={`Confidence in ${hypothesis.name}`}
                format={(n) => formatProbability(n / 100)}
                tone="hypothesis"
                showCaption
              />
              <p className={styles.meta}>
                {Math.abs(delta) < 0.0005
                  ? 'No change at the last event'
                  : `Moved ${formatNumber(delta * 100, { maximumFractionDigits: 1, signed: true })} points at the last event (estimate)`}
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
