'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import {
  Badge,
  HelpButton,
  IconButton,
  StatusBadge,
  borderColors,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { RefreshCwIcon, StarIcon } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { isAcceptedState, SEVERITY_BADGES } from '../reasoning/labels';
import { scenariosOfFork } from './model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  titleLine: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  hint: { margin: 0, flex: '1 1 240px', color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  // A long list scrolls sideways inside a named, focusable region, so every decision can be reached with the keyboard.
  scroller: {
    overflowX: 'auto',
    margin: `0 -${cg.space[1]}`,
    padding: `${cg.space[2]} ${cg.space[1]} ${cg.space[3]}`,
    scrollSnapType: 'x proximity',
    scrollbarWidth: 'thin',
    borderRadius: cg.radius.md,
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  list: {
    display: 'flex',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
    width: 'max-content',
  },
  item: { display: 'flex', flex: '0 0 auto', scrollSnapAlign: 'start' },
  chip: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: cg.space[2],
    boxSizing: 'border-box',
    width: '320px',
    maxWidth: 'calc(100vw - 56px)',
    minHeight: '44px',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    textAlign: 'start',
    font: 'inherit',
    color: cg.text,
    cursor: 'pointer',
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surface,
    boxShadow: `inset 0 1px 0 ${cg.highlight}`,
    transitionProperty: 'transform, border-color, background-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { transform: 'translateY(-2px)', ...borderColors(cg.borderControl) },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  selected: {
    backgroundColor: cg.tone.brand.tint,
    ...borderColors(cg.tone.brand.border),
    boxShadow: `inset 0 1px 0 ${cg.highlight}, 0 14px 36px -16px ${cg.glow}`,
    ':hover': borderColors(cg.tone.brand.border),
  },
  top: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[1]} ${cg.space[2]}`,
  },
  when: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  name: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  foot: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    marginTop: 'auto',
  },
  meta: { color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
});

const HELP =
  'A key decision is a moment where a better-supported step existed: a different action was available, an assumption was treated as fact, contradictory evidence was ignored, a low-value or destructive action was chosen, escalation came early, the customer was asked for a lot without proportional value, or a high-value signal went unused. The earliest meaningful one is the first whose estimated impact passes the threshold. Impact is an estimate.';

function pathSummary(paths: readonly CounterfactualScenario[]): string {
  if (paths.length === 0) return 'No simulated paths yet';
  const accepted = paths.filter((p) => isAcceptedState(p.reviewState)).length;
  const rejected = paths.filter((p) => p.reviewState === 'rejected').length;
  const parts = [`${paths.length} simulated ${paths.length === 1 ? 'path' : 'paths'}`];
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (rejected > 0) parts.push(`${rejected} rejected`);
  return parts.join(' · ');
}

export interface ForkSelectorProps {
  forks: readonly DecisionFork[];
  /** Id of the earliest meaningful key decision, marked. */
  earliestId: string | null;
  selectedId: string | null;
  /** All scenarios of the case, to show how many paths each key decision already has (null while they load). */
  scenarios: readonly CounterfactualScenario[] | null;
  onSelect: (forkId: string) => void;
  /** Reads the key decisions again. */
  onRefresh: () => void;
  refreshing: boolean;
}

/**
 * Every key decision of the case in time order as a chip, the earliest meaningful one marked, with why it was flagged
 * (severity, estimated impact lives in the decision itself) and how many simulated paths it already has. Choosing one
 * moves the whole screen to that moment.
 */
export function ForkSelector({
  forks,
  earliestId,
  selectedId,
  scenarios,
  onSelect,
  onRefresh,
  refreshing,
}: ForkSelectorProps) {
  const styles = useStyles();
  const headingId = useId();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Keep the chosen decision in view (a deep link can choose one far along the list) without moving the page.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!scroller || !target) return;
    const left = target.offsetLeft;
    const right = left + target.offsetWidth;
    if (left < scroller.scrollLeft || right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, left - 16);
    }
  }, [selectedId]);
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <div className={styles.head}>
        <div className={styles.titleLine}>
          <h2 id={headingId} className={styles.title}>
            Key decisions ({forks.length})
          </h2>
          <HelpButton label="About key decisions" title="Key decisions">
            {HELP}
          </HelpButton>
          <IconButton
            icon={<RefreshCwIcon />}
            label={refreshing ? 'Refreshing' : 'Refresh'}
            size="sm"
            disabledFocusable={refreshing}
            onClick={onRefresh}
          />
        </div>
        <p className={styles.hint}>
          Moments where a better path was available. Pick one to simulate and compare.
        </p>
      </div>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="region"
        aria-label="Key decisions, scrollable"
        // A scroll region must be focusable, or a keyboard user cannot scroll it.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <ol className={styles.list} aria-label="Key decisions in time order">
          {forks.map((fork, index) => {
            const isEarliest = fork.id === earliestId || fork.isEarliestMeaningful;
            const selected = fork.id === selectedId;
            const severity = SEVERITY_BADGES[fork.severity];
            const paths = scenarios ? scenariosOfFork(scenarios, fork.id) : null;
            return (
              <li key={fork.id} className={styles.item}>
                <button
                  type="button"
                  className={mergeClasses(styles.chip, selected && styles.selected)}
                  aria-pressed={selected}
                  onClick={() => onSelect(fork.id)}
                >
                  <span className={styles.top}>
                    <span className={styles.when}>
                      {index + 1} of {forks.length} · {formatDateTimeUtc(fork.timestamp)}
                    </span>
                    {isEarliest ? (
                      <Badge
                        tone="brand"
                        size="sm"
                        icon={<StarIcon />}
                        title="The earliest key decision where a clearly better path was available"
                      >
                        Earliest
                      </Badge>
                    ) : null}
                  </span>
                  <span className={styles.name} title={fork.title}>
                    {fork.title}
                  </span>
                  <span className={styles.foot}>
                    <StatusBadge status={severity.status} label={severity.label} size="small" />
                    <span className={styles.meta}>
                      {fork.eligibility.eligible
                        ? paths
                          ? pathSummary(paths)
                          : 'Loading simulated paths…'
                        : 'Not eligible for simulation'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
