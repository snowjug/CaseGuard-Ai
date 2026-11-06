'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import { STRATEGY_LABELS } from '@caseguard/schemas';
import {
  Badge,
  Card,
  HelpButton,
  ProvenanceBadge,
  VisuallyHidden,
  cg,
  formatDuration,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { FlaskConicalIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { LEVEL_LABELS } from '../reasoning/labels';
import { ForkHeader, ForkLinks } from './ForkHeader';
import { timeSaved, type TimeSaved } from './model';

const useStyles = makeStyles({
  card: { gap: cg.space[6] },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  body: {
    display: 'grid',
    gap: cg.space[6],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' },
  },
  result: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  decision: {
    minWidth: 0,
    paddingTop: cg.space[6],
    borderTop: `1px solid ${cg.borderSubtle}`,
    '@media (min-width: 1024px)': {
      paddingTop: 0,
      paddingInlineStart: cg.space[6],
      borderTop: 0,
      borderInlineStartWidth: '1px',
      borderInlineStartStyle: 'solid',
      borderInlineStartColor: cg.borderSubtle,
    },
  },
  headline: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  kicker: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
  },
  big: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: `0 ${cg.space[3]}`,
    margin: 0,
  },
  number: {
    fontSize: tokens.fontSizeHero900,
    lineHeight: tokens.lineHeightHero900,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    '@media (max-width: 639px)': {
      fontSize: tokens.fontSizeHero800,
      lineHeight: tokens.lineHeightHero800,
    },
  },
  unit: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightMedium,
  },
  statement: {
    margin: 0,
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    color: cg.text,
  },
  detail: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  bars: { display: 'flex', flexDirection: 'column', gap: cg.space[3], margin: 0 },
  row: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  rowHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: `0 ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase300,
  },
  rowLabel: { color: cg.textSecondary, fontWeight: tokens.fontWeightMedium },
  rowValue: {
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  rowRange: {
    color: cg.textMuted,
    fontWeight: tokens.fontWeightRegular,
    fontSize: tokens.fontSizeBase200,
  },
  track: {
    position: 'relative',
    height: '14px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surfaceSunken,
    border: `1px solid ${cg.borderSubtle}`,
    overflow: 'hidden',
  },
  actual: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.actual.solid,
  },
  // A hatched bar with a dashed edge is the grammar of a simulated value: it never reads as something that happened.
  simulated: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: cg.radius.pill,
    boxSizing: 'border-box',
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
    backgroundImage: `repeating-linear-gradient(135deg, ${cg.tone.simulated.solid} 0 4px, transparent 4px 8px)`,
  },
  band: {
    position: 'absolute',
    insetBlock: 0,
    backgroundColor: `color-mix(in srgb, ${cg.tone.simulated.solid} 24%, transparent)`,
  },
  confidence: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  help: { display: 'inline-flex', flexShrink: 0 },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: cg.space[2],
    minWidth: 0,
  },
  emptyIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: cg.radius.pill,
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
    color: cg.tone.simulated.fg,
    fontSize: '24px',
  },
});

export interface OutcomeHeroProps {
  caseId: string;
  fork: DecisionFork;
  /** The answer: the result of the chosen path, or why there is none yet. */
  children: ReactNode;
}

/**
 * The hero of the screen: what would have changed the outcome. The answer sits first (how much sooner the simulated path
 * reached a diagnosis, with its estimate range, against what happened) and the decision it is about beside it. Everything
 * in it carries the Estimated and Simulated badges: nothing here happened.
 */
export function OutcomeHero({ caseId, fork, children }: OutcomeHeroProps) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <Card hero glow padding="lg" role="group" aria-labelledby={headingId} className={styles.card}>
      <div className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          What would have changed the outcome
        </h2>
        <div className={styles.badges}>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.result}>{children}</div>
        <div className={styles.decision}>
          <ForkHeader fork={fork} />
        </div>
      </div>
      <ForkLinks caseId={caseId} fork={fork} />
    </Card>
  );
}

function Headline({ saved }: { saved: TimeSaved }) {
  const styles = useStyles();
  if (!saved.claimed) {
    return (
      <>
        <p className={styles.statement}>No saving is claimed</p>
        <p className={styles.detail}>
          This path is an illustration, so the engine claims no saving for it.
        </p>
      </>
    );
  }
  if (saved.verdict === 'faster') {
    return (
      <>
        <p className={styles.big}>
          <span className={styles.number}>{formatDuration(saved.saved.mid)}</span>
          <span className={styles.unit}>sooner to a diagnosis</span>
        </p>
        <p className={styles.detail}>
          Estimated range {formatDuration(saved.saved.low)} to {formatDuration(saved.saved.high)}. A
          simulation, not a measurement.
        </p>
      </>
    );
  }
  if (saved.verdict === 'slower') {
    return (
      <>
        <p className={styles.statement}>No time saved</p>
        <p className={styles.detail}>
          In this simulation the path takes longer: about {formatDuration(-saved.saved.mid)} more
          (range {formatDuration(-saved.saved.high)} to {formatDuration(-saved.saved.low)} more).
        </p>
      </>
    );
  }
  return (
    <>
      <p className={styles.statement}>No clear saving</p>
      <p className={styles.detail}>
        The simulated range ({formatDuration(saved.simulated.low)} to{' '}
        {formatDuration(saved.simulated.high)}) includes the {formatDuration(saved.recorded)} that
        happened, so this simulation cannot say the path would have been faster.
      </p>
    </>
  );
}

/** Two bars on one scale: how long it took to a diagnosis, and how long the simulated path is estimated to take. */
function Bars({ saved }: { saved: TimeSaved }) {
  const styles = useStyles();
  const top = Math.max(saved.recorded, saved.simulated.high, 1);
  const at = (minutes: number): string => `${Math.min(100, Math.max(0, (minutes / top) * 100))}%`;
  return (
    <figure
      className={styles.bars}
      aria-label="Time from the decision to a diagnosis: what happened against what could have happened"
    >
      <div className={styles.row}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabel}>What happened</span>
          <span className={styles.rowValue}>{formatDuration(saved.recorded)}</span>
        </div>
        <div className={styles.track} aria-hidden="true">
          <span className={styles.actual} style={{ width: at(saved.recorded) }} />
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabel}>What could have happened</span>
          <span className={styles.rowValue}>
            {formatDuration(saved.simulated.mid)}{' '}
            <span className={styles.rowRange}>
              (range {formatDuration(saved.simulated.low)} to {formatDuration(saved.simulated.high)}
              )
            </span>
          </span>
        </div>
        <div className={styles.track} aria-hidden="true">
          <span
            className={styles.band}
            style={{
              insetInlineStart: at(saved.simulated.low),
              width: `calc(${at(saved.simulated.high)} - ${at(saved.simulated.low)})`,
            }}
          />
          <span className={styles.simulated} style={{ width: at(saved.simulated.mid) }} />
        </div>
      </div>
      <VisuallyHidden as="figcaption">
        Simulated, estimated: {formatDuration(saved.simulated.mid)}, range{' '}
        {formatDuration(saved.simulated.low)} to {formatDuration(saved.simulated.high)}. Recorded:{' '}
        {formatDuration(saved.recorded)}.
      </VisuallyHidden>
    </figure>
  );
}

/** The result for the chosen path: the saving, the two bars and how far the comparison itself can be trusted. */
export function OutcomeResult({ scenario }: { scenario: CounterfactualScenario }) {
  const styles = useStyles();
  const saved = timeSaved(scenario);
  const confidence = scenario.comparisonConfidence;
  return (
    <>
      <section className={styles.headline} aria-label="Time that could have been saved">
        <p className={styles.kicker}>
          <span>Time that could have been saved</span>
          <Badge tone="neutral" size="sm" outlined>
            {STRATEGY_LABELS[scenario.strategy]}
          </Badge>
        </p>
        <Headline saved={saved} />
      </section>
      <Bars saved={saved} />
      <p className={styles.confidence}>
        <span>
          {`Confidence in this comparison: ${LEVEL_LABELS[confidence.level]} (${formatNumber(confidence.score, { maximumFractionDigits: 2 })} of 1)`}
        </span>
        <span className={styles.help}>
          <HelpButton
            label="About the confidence in this comparison"
            title="Confidence in this comparison"
          >
            {confidence.rationale}
          </HelpButton>
        </span>
      </p>
    </>
  );
}

/** What the answer says before any path exists: there is nothing to compare yet, and what to do about it. */
export function NoPathsYet({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.empty}>
      <span aria-hidden="true" className={styles.emptyIcon}>
        <FlaskConicalIcon />
      </span>
      <p className={styles.statement}>No simulated path yet</p>
      <p className={styles.detail}>{children}</p>
    </div>
  );
}
