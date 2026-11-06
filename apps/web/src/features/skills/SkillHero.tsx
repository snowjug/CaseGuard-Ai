'use client';

import type { SkillDetail, SkillExpectedBenefit } from '@caseguard/schemas';
import {
  Card,
  HelpButton,
  NumberTicker,
  RangeBar,
  cg,
  formatDuration,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId } from 'react';
import { EstimatedPill, SimulatedPill } from './Hints';
import { LifecycleStepper, furthestReached } from './LifecycleStepper';

const useStyles = makeStyles({
  // A phone gives the card less padding, so the stepper and the figure keep their width.
  card: { '@media (max-width: 639px)': { padding: cg.space[4] } },
  // Side by side only where the stepper's seven labels still fit in their column (wide screens); stacked otherwise.
  grid: {
    display: 'grid',
    gap: cg.space[8],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1280px)': {
      gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)',
      gap: cg.space[10],
    },
  },
  block: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  benefit: {
    paddingTop: cg.space[6],
    borderTop: `1px solid ${cg.borderSubtle}`,
    '@media (min-width: 1280px)': {
      paddingTop: 0,
      borderTop: 0,
      paddingLeft: cg.space[10],
      borderLeft: `1px solid ${cg.borderSubtle}`,
    },
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  heading: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  pills: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  figure: {
    margin: 0,
    fontSize: tokens.fontSizeHero900,
    lineHeight: tokens.lineHeightHero900,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    '@media (max-width: 639px)': {
      fontSize: tokens.fontSizeHero700,
      lineHeight: tokens.lineHeightHero700,
    },
  },
  figureLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  figureBlock: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: cg.space[4],
    margin: 0,
  },
  stat: { display: 'flex', flexDirection: 'column', gap: cg.space[1], margin: 0, minWidth: 0 },
  statLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  statValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  statRange: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
  quiet: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  list: { margin: 0, paddingLeft: cg.space[4] },
});

const STANDS_HELP = (
  <>
    <p>
      A skill is a reusable fix, taken from a case that was reviewed. SkillDNA is its technical
      name: a governed, reusable investigation plan.
    </p>
    <p>
      It moves forward one governed step at a time. Each step needs the right role, an independent
      person where the four-eyes rule applies, and its gate (for example a passed full simulation
      test). It can be sent back to Draft for changes, or withdrawn as Deprecated or Retired.
    </p>
    <p>
      Nothing is automatic: every step, proposed change and rollback is a person&apos;s decision,
      recorded with their name and reason.
    </p>
  </>
);
const BENEFIT_HELP =
  'A replay of the skill at the source decision point, compared with the recorded path of the source case. Nothing was executed, and the step outcomes use the recorded cause, so the figures are estimates that only demonstrate the method.';

/** `1 d 22 h`, or `1 d 22 h (range 1 d 20 h to 1 d 23 h)` when the estimate has a spread. */
function rangeText(
  values: SkillExpectedBenefit['timeSavedMinutes'],
  unit: (n: number) => string,
): string {
  const mid = unit(values.mid);
  return values.low === values.high
    ? mid
    : `${mid} (range ${unit(values.low)} to ${unit(values.high)})`;
}

function BenefitFigure({ benefit }: { benefit: SkillExpectedBenefit }) {
  const styles = useStyles();
  const time = benefit.timeSavedMinutes;
  const count = (n: number): string => formatNumber(n, { maximumFractionDigits: 0 });
  return (
    <>
      <div className={styles.figureBlock}>
        <p className={styles.figure}>
          <NumberTicker value={time.mid} format={formatDuration} />
        </p>
        <p className={styles.figureLabel}>saved on the way to a diagnosis</p>
      </div>
      <RangeBar
        value={time.mid}
        low={time.low}
        high={time.high}
        min={0}
        max={Math.max(time.high * 1.1, 1)}
        label="Estimated time saved"
        format={formatDuration}
        showCaption={false}
      />
      {time.low === time.high ? null : (
        <p className={styles.statRange}>
          Range {formatDuration(time.low)} to {formatDuration(time.high)}
        </p>
      )}
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Customer effort saved</dt>
          <dd className={styles.statValue}>
            {rangeText(benefit.customerEffortSavedMinutes, formatDuration)}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Tokens saved</dt>
          <dd className={styles.statValue}>{rangeText(benefit.tokensSaved, count)}</dd>
        </div>
      </dl>
    </>
  );
}

/** What the "Estimated" pill opens: how the figure was made and what it does not say. */
function BenefitBasis({ benefit }: { benefit: SkillExpectedBenefit }) {
  const styles = useStyles();
  return (
    <>
      <p>A model estimate with a range, not a measurement. {benefit.basis}</p>
      <ul className={styles.list}>
        {benefit.caveats.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * The top of a skill's page, in one glowing card: where the skill stands on its status path, and what following it is
 * expected to save, as one large figure that says it is an estimate. Everything else on the page is below it, in tabs.
 */
export function SkillHero({ detail }: { detail: SkillDetail }) {
  const styles = useStyles();
  const standsId = useId();
  const benefitId = useId();
  const { skill, currentVersion, approvals } = detail;
  const benefit = currentVersion.content.expectedBenefit;
  return (
    <Card glow hero padding="lg" className={styles.card}>
      <div className={styles.grid}>
        <div role="group" aria-labelledby={standsId} className={styles.block}>
          <div className={styles.head}>
            <h2 id={standsId} className={styles.heading}>
              Where this skill stands
            </h2>
            <HelpButton label="About Where this skill stands" title="Where this skill stands">
              {STANDS_HELP}
            </HelpButton>
          </div>
          <LifecycleStepper
            lifecycle={skill.lifecycle}
            reached={furthestReached(skill.lifecycle, approvals)}
          />
        </div>
        <div
          role="group"
          aria-labelledby={benefitId}
          className={mergeClasses(styles.block, styles.benefit)}
        >
          <div className={styles.head}>
            <h2 id={benefitId} className={styles.heading}>
              Expected benefit
            </h2>
            <div className={styles.pills}>
              <EstimatedPill>
                {benefit ? <BenefitBasis benefit={benefit} /> : undefined}
              </EstimatedPill>
              <SimulatedPill />
            </div>
            <HelpButton label="About Expected benefit" title="Expected benefit">
              {BENEFIT_HELP}
            </HelpButton>
          </div>
          {benefit ? (
            <BenefitFigure benefit={benefit} />
          ) : (
            <p className={styles.quiet}>
              No estimate yet. It appears once the skill has been replayed on its source case.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
