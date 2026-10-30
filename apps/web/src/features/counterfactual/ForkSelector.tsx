'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import { FORK_CATEGORY_LABELS } from '@caseguard/schemas';
import {
  BadgeShell,
  Panel,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { BranchForkRegular, StarRegular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';
import { isAcceptedState, SEVERITY_BADGES } from '../reasoning/labels';
import { scenariosOfFork } from './model';

const useStyles = makeStyles({
  scroller: {
    position: 'relative',
    // On a narrow screen the list stays short so the selected fork's details are never far below it.
    maxHeight: '320px',
    '@media (min-width: 1100px)': { maxHeight: 'min(68vh, 760px)' },
    overflowY: 'auto',
    margin: `0 -${cg.space[1]}`,
    padding: `${cg.space[1]}`,
    borderRadius: cg.radius.md,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    width: '100%',
    boxSizing: 'border-box',
    textAlign: 'start',
    padding: `${cg.space[3]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    font: 'inherit',
    cursor: 'pointer',
    minHeight: '44px',
    ':hover': { border: `1px solid ${cg.borderControl}` },
    ':focus-visible': { outline: `3px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  earliest: {
    border: `2px solid ${cg.tone.fork.solid}`,
    backgroundColor: cg.tone.fork.tint,
  },
  selected: { boxShadow: `inset 5px 0 0 ${cg.text}` },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  when: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  meta: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  intro: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

const HELP =
  'A decision fork is a moment where a different action was available, an assumption was treated as fact, contradictory evidence was ignored, a low-value or destructive action was chosen, escalation came early, the customer was asked for a lot without proportional value, or a high-value signal went unused. The earliest meaningful fork is the first one whose estimated impact passes the threshold. Impact is an estimate.';

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
  /** Id of the earliest meaningful fork, highlighted. */
  earliestId: string | null;
  selectedId: string | null;
  /** All scenarios of the case, to show how many paths each fork already has (null while they load). */
  scenarios: readonly CounterfactualScenario[] | null;
  onSelect: (forkId: string) => void;
}

/**
 * Every decision fork of the case in time order, with the earliest meaningful one highlighted, why it was flagged
 * (category, severity, estimated impact) and how many simulated paths it already has.
 */
export function ForkSelector({
  forks,
  earliestId,
  selectedId,
  scenarios,
  onSelect,
}: ForkSelectorProps) {
  const styles = useStyles();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Keep the selected fork visible inside the list (a deep link can select one far down) without moving the page.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!scroller || !target) return;
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, top - 8);
    }
  }, [selectedId]);
  return (
    <Panel
      title={`Decision forks (${forks.length})`}
      description="Moments where a better path was available. Choose one to simulate and compare."
      help={HELP}
      accent="fork"
    >
      <p className={styles.intro}>
        The earliest meaningful fork is outlined: it is the first decision where a clearly better
        path was available.
      </p>
      {/* A long list scrolls inside a named, focusable region so keyboard users can reach every fork. */}
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="region"
        aria-label="Decision forks, scrollable"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <ol className={styles.list} aria-label="Decision forks in time order">
          {forks.map((fork, index) => {
            const isEarliest = fork.id === earliestId || fork.isEarliestMeaningful;
            const selected = fork.id === selectedId;
            const severity = SEVERITY_BADGES[fork.severity];
            const paths = scenarios ? scenariosOfFork(scenarios, fork.id) : null;
            return (
              <li key={fork.id}>
                <button
                  type="button"
                  className={mergeClasses(
                    styles.item,
                    isEarliest && styles.earliest,
                    selected && styles.selected,
                  )}
                  aria-pressed={selected}
                  onClick={() => onSelect(fork.id)}
                >
                  <span className={styles.row}>
                    <BranchForkRegular aria-hidden="true" />
                    <span className={styles.when}>
                      Fork {index + 1} of {forks.length} · {formatDateTimeUtc(fork.timestamp)}
                    </span>
                    {isEarliest ? (
                      <BadgeShell
                        tone="fork"
                        pattern="solid"
                        icon={<StarRegular />}
                        label="Earliest meaningful"
                        size="small"
                      />
                    ) : null}
                  </span>
                  <span className={styles.title}>{fork.title}</span>
                  <span className={styles.row}>
                    <span className={styles.meta}>{FORK_CATEGORY_LABELS[fork.category]}</span>
                    <StatusBadge status={severity.status} label={severity.label} size="small" />
                    <span className={styles.meta}>
                      Impact {formatProbability(fork.impactScore)} (estimate)
                    </span>
                  </span>
                  <span className={styles.meta}>
                    {fork.eligibility.eligible
                      ? paths
                        ? pathSummary(paths)
                        : 'Loading simulated paths…'
                      : 'Not eligible for simulation'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}
