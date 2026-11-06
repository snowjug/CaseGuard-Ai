'use client';

import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  type EvidenceCategory,
} from '@caseguard/schemas';
import {
  Button,
  Card,
  HelpButton,
  NumberTicker,
  Tooltip,
  borderColors,
  cg,
  formatNumber,
  formatPercent,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CircleCheckIcon, CircleHelpIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { CATEGORY_META, categoryPaint } from './category-meta';

const useStyles = makeStyles({
  root: { gap: cg.space[4] },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 280px',
  },
  titleLine: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  sub: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  figures: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[4]}`,
  },
  total: { display: 'inline-flex', alignItems: 'baseline', gap: cg.space[2] },
  big: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
  },
  unit: { fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  bar: {
    display: 'flex',
    gap: '3px',
    height: '20px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  segment: {
    flexBasis: 0,
    minWidth: '8px',
    boxSizing: 'border-box',
    height: '100%',
    padding: 0,
    border: '1px solid transparent',
    borderRadius: '6px',
    cursor: 'pointer',
    transitionProperty: 'opacity, transform',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { transform: 'translateY(-1px)' },
  },
  dimmed: { opacity: 0.35 },
  chosen: { outline: `2px solid ${cg.tone.brand.solid}`, outlineOffset: '2px' },
  empty: {
    height: '100%',
    flex: 1,
    borderRadius: '6px',
    border: `1px dashed ${cg.borderControl}`,
  },
  legend: {
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
    gap: cg.space[2],
    boxSizing: 'border-box',
    minHeight: '32px',
    padding: `0 ${cg.space[3]}`,
    border: `1px solid ${cg.borderSubtle}`,
    borderRadius: cg.radius.sm,
    backgroundColor: 'transparent',
    color: cg.textSecondary,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: cg.motion.fast,
    ':hover': { color: cg.text, backgroundColor: `color-mix(in srgb, ${cg.text} 6%, transparent)` },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  chipOn: {
    color: cg.text,
    backgroundColor: cg.tone.brand.tint,
    ...borderColors(cg.tone.brand.border),
  },
  swatch: {
    display: 'inline-block',
    flexShrink: 0,
    width: '14px',
    height: '14px',
    boxSizing: 'border-box',
    border: '1px solid transparent',
    borderRadius: '4px',
  },
  count: {
    color: cg.text,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: tokens.fontWeightSemibold,
  },
  extra: { display: 'flex', flexDirection: 'column', gap: cg.space[1], marginTop: cg.space[1] },
});

const HELP =
  'Confirmed facts are checked against the record. Customer-reported observations are what the customer said. Engineer assumptions are statements with no evidence behind them. Diagnostic evidence comes from logs and tool output. AI inferences are conclusions drawn from the rest. Conflicting evidence contradicts another claim. Missing evidence was needed and not collected. Simulated outcomes come from what-if paths, never from the case itself.';

export interface CoverageBarProps {
  /** Claims per category: all the claims known in the view, before the other filters. */
  counts: Readonly<Record<string, number>>;
  selected: 'all' | EvidenceCategory;
  onSelect: (category: 'all' | EvidenceCategory) => void;
  /** Evidence a careful investigation needs and nobody has collected yet. */
  missingOpen: number;
  missingCritical: number;
  /** All the requirements that apply in the view, collected or not. */
  missingTotal: number;
  /** Opens the list of what is still missing. */
  onShowMissing: () => void;
  /** What sits under the bar: the collapsed sections. */
  children?: ReactNode;
}

/**
 * The first thing the evidence page says: how many claims there are and what they rest on. One bar with a segment per
 * category (each segment is a filter), a key that is the accessible form of the same filter, and how much evidence is
 * still missing. The segments carry a texture as well as a colour, so no category depends on colour alone.
 */
export function CoverageBar({
  counts,
  selected,
  onSelect,
  missingOpen,
  missingCritical,
  missingTotal,
  onShowMissing,
  children,
}: CoverageBarProps) {
  const styles = useStyles();
  const headingId = useId();
  const total = EVIDENCE_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0), 0);
  const choose = (category: EvidenceCategory): void =>
    onSelect(selected === category ? 'all' : category);

  return (
    <Card as="section" aria-labelledby={headingId} glow hero className={styles.root}>
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <div className={styles.titleLine}>
            <h2 id={headingId} className={styles.title}>
              Evidence coverage
            </h2>
            <HelpButton label="About evidence coverage" title="Evidence coverage">
              {HELP}
            </HelpButton>
          </div>
          <p className={styles.sub}>
            Every claim sits in one of eight categories. Choose a segment to filter the list.
          </p>
        </div>
        <div className={styles.figures}>
          <span className={styles.total}>
            <span className={styles.big}>
              <NumberTicker
                value={total}
                format={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
              />
            </span>
            <span className={styles.unit}>{total === 1 ? 'claim' : 'claims'}</span>
          </span>
          {missingTotal === 0 ? null : (
            <Tooltip content="Open the list of what the investigation needed">
              <Button
                variant="secondary"
                size="sm"
                icon={missingOpen === 0 ? <CircleCheckIcon /> : <CircleHelpIcon />}
                onClick={onShowMissing}
              >
                {missingOpen === 0
                  ? 'Nothing still missing'
                  : `${formatNumber(missingOpen)} still missing${
                      missingCritical > 0 ? `, ${formatNumber(missingCritical)} critical` : ''
                    }`}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className={styles.bar} aria-hidden="true">
        {total === 0 ? <span className={styles.empty} /> : null}
        {EVIDENCE_CATEGORIES.map((category) => {
          const count = counts[category] ?? 0;
          if (count <= 0) return null;
          const chosen = selected === category;
          return (
            <Tooltip
              key={category}
              content={`${EVIDENCE_CATEGORY_LABELS[category]}: ${formatNumber(count)} ${
                count === 1 ? 'claim' : 'claims'
              } (${formatPercent((count / total) * 100, 0)})`}
            >
              <button
                type="button"
                tabIndex={-1}
                className={mergeClasses(
                  styles.segment,
                  selected !== 'all' && !chosen && styles.dimmed,
                  chosen && styles.chosen,
                )}
                style={{ flexGrow: count, ...categoryPaint(category) }}
                data-category={category}
                onClick={() => choose(category)}
              />
            </Tooltip>
          );
        })}
      </div>

      <ul className={styles.legend} aria-label="Filter by evidence category">
        <li>
          <button
            type="button"
            className={mergeClasses(styles.chip, selected === 'all' && styles.chipOn)}
            aria-pressed={selected === 'all'}
            onClick={() => onSelect('all')}
          >
            <span>All categories</span> <span className={styles.count}>{formatNumber(total)}</span>
          </button>
        </li>
        {EVIDENCE_CATEGORIES.map((category) => {
          const pressed = selected === category;
          return (
            <li key={category}>
              <button
                type="button"
                className={mergeClasses(styles.chip, pressed && styles.chipOn)}
                aria-pressed={pressed}
                title={CATEGORY_META[category].meaning}
                onClick={() => choose(category)}
              >
                <span
                  aria-hidden="true"
                  className={styles.swatch}
                  style={categoryPaint(category)}
                />
                <span>{EVIDENCE_CATEGORY_LABELS[category]}</span>{' '}
                <span className={styles.count}>{formatNumber(counts[category] ?? 0)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {children ? <div className={styles.extra}>{children}</div> : null}
    </Card>
  );
}
