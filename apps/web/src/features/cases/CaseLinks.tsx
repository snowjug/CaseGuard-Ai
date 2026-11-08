'use client';

import type { AnalysisRun } from '@caseguard/schemas';
import { NumberTicker, UiLink, borderColors, cg, formatNumber } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { caseHref } from '../../lib/deep-links';
import { CASE_TABS, NAV_ITEMS } from '../../lib/nav';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' },
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    height: '100%',
    boxSizing: 'border-box',
    minHeight: '88px',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    textDecorationLine: 'none',
    transitionProperty: 'transform, border-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': {
      transform: 'translateY(-2px)',
      ...borderColors(cg.tone.brand.border),
      boxShadow: `0 14px 36px -18px ${cg.glow}`,
    },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  where: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[2],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  icon: { display: 'inline-flex', color: cg.tone.brand.fg, fontSize: '1.25em' },
  stat: { display: 'flex', alignItems: 'baseline', gap: cg.space[2], flexWrap: 'wrap' },
  value: {
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.01em',
  },
  unit: { color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  second: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  moment: { color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  // Five tiles in two columns would leave one alone on the last row of a phone: it takes the whole row instead.
  alone: { '@media (max-width: 639px)': { gridColumn: '1 / -1' } },
});

interface Stat {
  value: number;
  unit: string;
}

const stat = (value: number, singular: string, plural = `${singular}s`): Stat => ({
  value,
  unit: value === 1 ? singular : plural,
});

interface Destination {
  /** The id of the case tab and of the navigation item (they share it). */
  navId: string;
  section: string;
  /** The headline figure, then optionally one more. */
  stats: (counts: AnalysisRun['counts']) => readonly [Stat, ...Stat[]];
}

const DESTINATIONS: readonly Destination[] = [
  { navId: 'timeline', section: 'timeline', stats: (c) => [stat(c.events, 'event')] },
  {
    navId: 'evidence',
    section: 'evidence',
    stats: (c) => [stat(c.claims, 'claim'), stat(c.evidence, 'evidence item')],
  },
  {
    navId: 'hypotheses',
    section: 'hypotheses',
    stats: (c) => [stat(c.hypotheses, 'possible cause')],
  },
  {
    navId: 'counterfactual',
    section: 'counterfactual',
    stats: (c) => [stat(c.forks, 'key decision')],
  },
  { navId: 'quality', section: 'quality', stats: (c) => [stat(c.warnings, 'open warning')] },
];

export interface CaseLinksProps {
  caseId: string;
  asOf: string | null;
  /** Totals of the latest analysis; omitted while a time cursor is set (they describe the whole record). */
  counts: AnalysisRun['counts'] | null;
}

/**
 * The case in numbers, each a link to the page that shows it. With a time cursor set the figures of the whole record are
 * not shown, and the links carry the moment so each page opens at the same one.
 */
export function CaseLinks({ caseId, asOf, counts }: CaseLinksProps) {
  const styles = useStyles();
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <ul className={styles.grid} aria-label="Case pages">
      {DESTINATIONS.map((destination, index) => {
        const label = CASE_TABS.find((tab) => tab.id === destination.navId)?.label;
        const Icon = NAV_ITEMS.find((item) => item.id === destination.navId)?.icon;
        if (!label || !Icon) return null;
        const stats = counts ? destination.stats(counts) : null;
        const [first, ...rest] = stats ?? [];
        const alone = index === DESTINATIONS.length - 1 && DESTINATIONS.length % 2 === 1;
        return (
          <li key={destination.navId} className={alone ? styles.alone : undefined}>
            <UiLink
              href={`${caseHref(caseId, destination.section)}${query}`}
              className={styles.tile}
            >
              <span className={styles.where}>
                <span aria-hidden="true" className={styles.icon}>
                  <Icon />
                </span>
                {label}
              </span>{' '}
              {first ? (
                <>
                  <span className={styles.stat}>
                    <span className={styles.value}>
                      <NumberTicker
                        value={first.value}
                        format={(n) => formatNumber(n, { maximumFractionDigits: 0 })}
                      />
                    </span>{' '}
                    <span className={styles.unit}>{first.unit}</span>
                  </span>
                  {rest.map((more) => (
                    <span key={more.unit} className={styles.second}>
                      {' '}
                      {formatNumber(more.value, { maximumFractionDigits: 0 })} {more.unit}
                    </span>
                  ))}
                </>
              ) : (
                <span className={styles.moment}>{asOf ? 'At this moment' : 'Open'}</span>
              )}
            </UiLink>
          </li>
        );
      })}
    </ul>
  );
}
