'use client';

import type { Hypothesis } from '@caseguard/schemas';
import {
  Button,
  RangeBar,
  SectionHeader,
  StatusBadge,
  cg,
  formatNumber,
  formatProbability,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, useState } from 'react';
import { HYPOTHESIS_STATUS_BADGES } from '../reasoning/labels';
import { latestPoint } from './model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    overflow: 'hidden',
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surface,
  },
  item: {
    position: 'relative',
    display: 'grid',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    padding: `${cg.space[4]} ${cg.space[6]}`,
    gridTemplateColumns: 'minmax(0, 1fr)',
    transitionProperty: 'background-color',
    transitionDuration: cg.motion.fast,
    ':hover': { backgroundColor: `color-mix(in srgb, ${cg.text} 4%, transparent)` },
    '&:not(:first-child)': { borderTop: `1px solid ${cg.borderSubtle}` },
    '@media (min-width: 768px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(200px, 300px)' },
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  selected: {
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
    ':hover': { backgroundColor: cg.tone.brand.tint },
  },
  pick: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    boxSizing: 'border-box',
    minHeight: '32px',
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.text,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    // The button stretches over the whole row, so a pointer can pick it anywhere while the button stays the one stop
    // for keyboards and screen readers.
    '::after': { content: '""', position: 'absolute', inset: 0 },
    ':focus-visible': { outline: 'none' },
    ':focus-visible::after': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
  },
  rank: {
    minWidth: '24px',
    fontVariantNumeric: 'tabular-nums',
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  name: {
    flex: '1 1 160px',
    minWidth: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  meter: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  figure: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: cg.space[2],
    fontVariantNumeric: 'tabular-nums',
  },
  percent: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
  range: { color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  meta: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    '@media (min-width: 768px)': { gridColumn: '1 / -1' },
  },
  empty: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
});

export interface HypothesisListProps {
  /** The causes after the leading one, ranked by confidence at the boundary (the API already ranks them). */
  hypotheses: readonly Hypothesis[];
  /** The rank of the first of them (the leading cause is the first). */
  startRank?: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** How many of the other causes are listed before "Show all": the rest are usually the same few percent. */
const LISTED = 5;

/** The other possible causes, ranked, each with its estimated confidence as a meter and its range. Choosing one opens its evidence. */
export function HypothesisList({
  hypotheses,
  startRank = 2,
  selectedId,
  onSelect,
}: HypothesisListProps) {
  const styles = useStyles();
  const headingId = useId();
  const restoreFocus = useRestoreFocusTarget();
  const [all, setAll] = useState(false);
  const shown = all ? hypotheses : hypotheses.slice(0, LISTED);
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <SectionHeader
        id={headingId}
        title="Other possible causes"
        description="Ranked by estimated confidence at this time. Choose one to see its evidence."
        help="The model keeps every explanation alive instead of picking a root cause early. Confidence is a model estimate from an authored knowledge pack, shown with its range; it is not a statistical probability."
      />
      {hypotheses.length === 0 ? (
        <p className={styles.empty}>Only one possible cause has been scored so far.</p>
      ) : (
        <>
          <ol className={styles.list} aria-label="Possible causes ranked by confidence">
            {shown.map((hypothesis, index) => {
              const badge = HYPOTHESIS_STATUS_BADGES[hypothesis.currentStatus];
              const delta = latestPoint(hypothesis)?.delta ?? 0;
              const selected = hypothesis.id === selectedId;
              const percent = formatProbability(hypothesis.currentConfidence);
              const low = formatProbability(hypothesis.currentLow);
              const high = formatProbability(hypothesis.currentHigh);
              return (
                <li
                  key={hypothesis.id}
                  className={mergeClasses(styles.item, selected && styles.selected)}
                >
                  <button
                    type="button"
                    className={styles.pick}
                    aria-haspopup="dialog"
                    onClick={() => onSelect(hypothesis.id)}
                    {...restoreFocus}
                  >
                    <span className={styles.rank} aria-hidden="true">
                      {startRank + index}
                    </span>
                    <span className={styles.name}>{hypothesis.name}</span>
                    <StatusBadge status={badge.status} label={badge.label} size="small" />
                  </button>
                  <div className={styles.meter}>
                    <div className={styles.figure} aria-hidden="true">
                      <span className={styles.percent}>{percent}</span>
                      {low !== percent || high !== percent ? (
                        <span className={styles.range}>
                          range {low}–{high}
                        </span>
                      ) : null}
                    </div>
                    <RangeBar
                      value={hypothesis.currentConfidence * 100}
                      low={hypothesis.currentLow * 100}
                      high={hypothesis.currentHigh * 100}
                      label={`Confidence in ${hypothesis.name}`}
                      format={(n) => formatProbability(n / 100)}
                      tone="hypothesis"
                      showCaption={false}
                    />
                  </div>
                  {Math.abs(delta) >= 0.0005 ? (
                    <p className={styles.meta}>
                      Moved {formatNumber(delta * 100, { maximumFractionDigits: 1, signed: true })}{' '}
                      points at the last event (estimate)
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {hypotheses.length > LISTED ? (
            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={all}
                onClick={() => setAll((value) => !value)}
              >
                {all ? 'Show fewer' : `Show ${hypotheses.length - LISTED} more possible causes`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
