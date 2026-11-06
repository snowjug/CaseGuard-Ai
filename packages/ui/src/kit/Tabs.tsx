'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { motion as m } from 'motion/react';
import {
  createContext,
  useContext,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { UiLink } from '../link-context';
import { useMotionEnabled } from '../motion/useMotionEnabled';
import { cg } from '../tokens/cg';
import { motion } from '../tokens/static';

const useStyles = makeStyles({
  list: {
    position: 'relative',
    display: 'flex',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    borderBottom: `1px solid ${cg.borderSubtle}`,
    '::-webkit-scrollbar': { display: 'none' },
  },
  item: { display: 'flex', flexShrink: 0 },
  tab: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[2],
    minHeight: '44px',
    paddingInline: cg.space[3],
    border: 0,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: cg.textSecondary,
    whiteSpace: 'nowrap',
    textDecorationLine: 'none',
    borderRadius: `${cg.radius.sm} ${cg.radius.sm} 0 0`,
    transitionProperty: 'color, background-color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { color: cg.text },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
    ':disabled': { cursor: 'not-allowed', opacity: 0.5 },
  },
  selected: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  icon: { display: 'inline-flex', fontSize: '1.15em' },
  indicator: {
    position: 'absolute',
    left: cg.space[3],
    right: cg.space[3],
    bottom: '-1px',
    height: '2px',
    borderRadius: cg.radius.pill,
    backgroundImage: cg.gradientAccent,
    boxShadow: `0 0 12px ${cg.glow}`,
  },
});

/** The sliding underline of the selected tab; with reduced motion it simply sits under the selected tab. */
function Indicator({ layoutId }: { layoutId: string }) {
  const styles = useStyles();
  const enabled = useMotionEnabled();
  return enabled ? (
    <m.span
      layoutId={layoutId}
      aria-hidden="true"
      className={styles.indicator}
      transition={{ duration: motion.base / 1000, ease: motion.curve }}
    />
  ) : (
    <span aria-hidden="true" className={styles.indicator} />
  );
}

const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

interface TabsContextValue {
  value: string;
  baseId: string;
}
const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabItem[];
  /** Names the tab list for assistive technology. */
  'aria-label': string;
  /** The `TabPanel`s. */
  children?: ReactNode;
  className?: string;
}

/**
 * Tabs for content that swaps in place (WAI-ARIA tabs): arrow keys, Home and End move between tabs, the selected tab is
 * the only one in the tab order, and a sliding underline marks it. Use `TabNav` when each tab is its own page.
 */
export function Tabs({
  value,
  onValueChange,
  items,
  'aria-label': ariaLabel,
  children,
  className,
}: TabsProps) {
  const styles = useStyles();
  const baseId = useId();
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const enabledItems = items.filter((item) => !item.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key) ||
      enabledItems.length === 0
    )
      return;
    const index = Math.max(
      0,
      enabledItems.findIndex((item) => item.value === value),
    );
    const last = enabledItems.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % enabledItems.length
            : (index - 1 + enabledItems.length) % enabledItems.length;
    const target = enabledItems[next];
    if (!target) return;
    event.preventDefault();
    onValueChange(target.value);
    nodes.current.get(target.value)?.focus();
  };

  return (
    <TabsContext.Provider value={{ value, baseId }}>
      {/* The key handling belongs to the tab list as a whole (roving focus), as the ARIA tabs pattern specifies. */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={mergeClasses(styles.list, className)}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              ref={(node) => {
                if (node) nodes.current.set(item.value, node);
                else nodes.current.delete(item.value);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${safeId(item.value)}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${safeId(item.value)}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className={mergeClasses(styles.tab, selected && styles.selected)}
              onClick={() => onValueChange(item.value)}
            >
              {item.icon ? (
                <span aria-hidden="true" className={styles.icon}>
                  {item.icon}
                </span>
              ) : null}
              {item.label}
              {item.badge}
              {selected ? <Indicator layoutId={`${baseId}-indicator`} /> : null}
            </button>
          );
        })}
      </div>
      {children}
    </TabsContext.Provider>
  );
}

export interface TabPanelProps {
  value: string;
  children?: ReactNode;
  className?: string;
}

/** The content of one tab. Only the selected panel is rendered. */
export function TabPanel({ value, children, className }: TabPanelProps) {
  const context = useContext(TabsContext);
  if (!context || context.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${context.baseId}-panel-${safeId(value)}`}
      aria-labelledby={`${context.baseId}-tab-${safeId(value)}`}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}

export interface TabNavItem {
  href: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** True for the page being shown. */
  active: boolean;
}

export interface TabNavProps {
  items: readonly TabNavItem[];
  'aria-label': string;
  className?: string;
}

/** The same look as `Tabs`, for tabs that are separate pages: real links, `aria-current="page"` on the current one. */
export function TabNav({ items, 'aria-label': ariaLabel, className }: TabNavProps) {
  const styles = useStyles();
  const layoutId = useId();
  return (
    <nav aria-label={ariaLabel}>
      <ul className={mergeClasses(styles.list, className)}>
        {items.map((item) => (
          <li key={item.href} className={styles.item}>
            <UiLink
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={mergeClasses(styles.tab, item.active && styles.selected)}
            >
              {item.icon ? (
                <span aria-hidden="true" className={styles.icon}>
                  {item.icon}
                </span>
              ) : null}
              {item.label}
              {item.badge}
              {item.active ? <Indicator layoutId={`${layoutId}-indicator`} /> : null}
            </UiLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
