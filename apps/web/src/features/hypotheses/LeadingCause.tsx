'use client';

import type { Hypothesis } from '@caseguard/schemas';
import {
  Button,
  Card,
  NumberTicker,
  ProvenanceBadge,
  RangeBar,
  StatusBadge,
  cg,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronRightIcon, ListOrderedIcon } from 'lucide-react';
import { useId } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { HYPOTHESIS_STATUS_BADGES } from '../reasoning/labels';
import { standingReason } from './model';

const useStyles = makeStyles({
  root: { gap: cg.space[4] },
  grid: {
    display: 'grid',
    gap: `${cg.space[6]} ${cg.space[8]}`,
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'center',
    '@media (min-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 300px)' },
  },
  text: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  kicker: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  overline: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  name: {
    margin: 0,
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    overflowWrap: 'anywhere',
  },
  next: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  nextLabel: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  figure: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: `color-mix(in srgb, ${cg.surfaceSunken} 70%, transparent)`,
    border: `1px solid ${cg.borderSubtle}`,
  },
  figureHead: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  big: {
    fontSize: tokens.fontSizeHero900,
    lineHeight: tokens.lineHeightHero900,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
  },
  caption: { margin: 0, color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
});

export interface LeadingCauseProps {
  /** The cause the model rates highest at the moment shown. */
  hypothesis: Hypothesis;
  /** Opens its evidence in the drawer. */
  onOpen: () => void;
  /** Goes to the ranking of next tests. */
  onShowRanking: () => void;
}

/**
 * The answer first: the possible cause the model rates highest, its confidence as a figure that reads from across the
 * room (always an estimate, with its range), the model's reason in one line and the best next test. Its evidence is one
 * click away, in the drawer.
 */
export function LeadingCause({ hypothesis, onOpen, onShowRanking }: LeadingCauseProps) {
  const styles = useStyles();
  const headingId = useId();
  const status = HYPOTHESIS_STATUS_BADGES[hypothesis.currentStatus];
  const reason = standingReason(hypothesis) ?? hypothesis.description;
  const action = hypothesis.cheapestSafeAction;
  return (
    <Card as="section" aria-labelledby={headingId} glow hero padding="lg" className={styles.root}>
      <div className={styles.grid}>
        <div className={styles.text}>
          <div className={styles.kicker}>
            <StatusBadge status={status.status} label={status.label} />
            <span className={styles.overline}>Most likely cause</span>
          </div>
          <h2 id={headingId} className={styles.name}>
            {hypothesis.name}
          </h2>
          <ExpandableText text={reason} lines={2} label="reason" />
          {action ? (
            <p className={styles.next}>
              <span className={styles.nextLabel}>Best next test</span>
              <strong>{action.label}</strong>
            </p>
          ) : (
            <p className={styles.next}>
              {hypothesis.currentStatus === 'confirmed' || hypothesis.currentStatus === 'ruled_out'
                ? 'Nothing more needs testing: this cause is already settled on the evidence.'
                : 'No safe test is suggested at this time.'}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              icon={<ChevronRightIcon />}
              iconPosition="end"
              aria-haspopup="dialog"
              aria-label={`See the evidence for ${hypothesis.name}`}
              onClick={onOpen}
            >
              See evidence
            </Button>
            {action ? (
              <Button variant="ghost" icon={<ListOrderedIcon />} onClick={onShowRanking}>
                How it ranks
              </Button>
            ) : null}
          </div>
        </div>
        <div className={styles.figure}>
          <div className={styles.figureHead}>
            <span className={styles.big}>
              <NumberTicker
                value={hypothesis.currentConfidence * 100}
                format={(value) => `${formatNumber(value, { maximumFractionDigits: 0 })}%`}
              />
            </span>
            <ProvenanceBadge kind="estimated" />
          </div>
          <RangeBar
            value={hypothesis.currentConfidence * 100}
            low={hypothesis.currentLow * 100}
            high={hypothesis.currentHigh * 100}
            label={`Confidence in ${hypothesis.name}`}
            format={(n) => formatProbability(n / 100)}
            tone="hypothesis"
            showCaption
          />
          <p className={styles.caption}>A model estimate with a range, not statistical truth.</p>
        </div>
      </div>
    </Card>
  );
}
