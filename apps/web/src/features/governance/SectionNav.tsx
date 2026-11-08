'use client';

import { borderColors, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[1],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surfaceSunken,
    border: `1px solid ${cg.glassBorder}`,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '40px',
    padding: `0 ${cg.space[3]}`,
    border: '1px solid transparent',
    borderRadius: cg.radius.md,
    backgroundColor: 'transparent',
    color: cg.textSecondary,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color, color, border-color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { color: cg.text },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '1px' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  selected: {
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    backgroundColor: cg.surfaceRaised,
    ...borderColors(cg.glassBorder),
    boxShadow: `inset 0 1px 0 ${cg.highlight}, ${cg.shadowLow}`,
  },
  icon: { display: 'inline-flex', flexShrink: 0, fontSize: '1.15em' },
  iconSelected: { color: cg.tone.brand.fg },
  label: { minWidth: 0, overflowWrap: 'anywhere' },
});

export interface SectionNavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface SectionNavProps {
  items: readonly SectionNavItem[];
  value: string;
  onValueChange: (id: string) => void;
  /** Names the list for assistive technology. */
  'aria-label': string;
  /** Prefix of the tab ids (`<prefix>-<id>`), so a tab panel can name itself after its tab. */
  idPrefix: string;
}

/**
 * A vertical segmented list of sections (WAI-ARIA tabs, vertical): arrow keys, Home and End move between the sections
 * without opening each one, Enter or Space opens the focused one, and only the open section is in the tab order. The
 * section is chosen in the URL, so opening one is a deliberate act and not a side effect of passing over it.
 */
export function SectionNav({
  items,
  value,
  onValueChange,
  'aria-label': ariaLabel,
  idPrefix,
}: SectionNavProps) {
  const styles = useStyles();
  const nodes = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const focused = items.findIndex(
      (item) => nodes.current.get(item.id) === document.activeElement,
    );
    const current =
      focused >= 0
        ? focused
        : Math.max(
            0,
            items.findIndex((item) => item.id === value),
          );
    const last = items.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    const target = items[next];
    if (!target) return;
    event.preventDefault();
    nodes.current.get(target.id)?.focus();
  };

  return (
    // The key handling belongs to the list as a whole (roving focus), as the ARIA tabs pattern specifies.
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      className={styles.list}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) nodes.current.set(item.id, node);
              else nodes.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={mergeClasses(styles.tab, selected && styles.selected)}
            onClick={() => onValueChange(item.id)}
          >
            <span
              aria-hidden="true"
              className={mergeClasses(styles.icon, selected && styles.iconSelected)}
            >
              {item.icon}
            </span>
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
