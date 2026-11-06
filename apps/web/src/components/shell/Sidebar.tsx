'use client';

import { Logo, UiLink, cg, layout, useMotionEnabled, motion } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { motion as m } from 'motion/react';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { PRIMARY_NAV, type PrimaryNavItem } from '../../lib/nav';
import { useNavBadges, type NavBadge } from '../../lib/nav-badges';
import { usePresenterHighlight } from '../../lib/presentation';
import { AccountMenu } from './AccountMenu';

const rail = `@media (max-width: ${layout.railBreakpoint - 1}px)`;
const hidden = `@media (max-width: ${layout.drawerBreakpoint - 1}px)`;

const useStyles = makeStyles({
  root: {
    position: 'sticky',
    top: 0,
    alignSelf: 'flex-start',
    flexShrink: 0,
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[6],
    boxSizing: 'border-box',
    width: `${layout.navWidth}px`,
    height: '100dvh',
    padding: `${cg.space[4]} ${cg.space[3]}`,
    borderRight: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.glass,
    backdropFilter: 'blur(16px) saturate(1.1)',
    [rail]: { width: `${layout.navRailWidth}px`, paddingInline: cg.space[2] },
    [hidden]: { display: 'none' },
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '40px',
    paddingInline: cg.space[2],
    textDecorationLine: 'none',
    color: cg.text,
    borderRadius: cg.radius.md,
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    [rail]: { justifyContent: 'center', paddingInline: 0 },
  },
  wordmarkOnly: { [rail]: { display: 'none' } },
  markOnly: { display: 'none', [rail]: { display: 'inline-flex' } },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  link: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    minHeight: '40px',
    paddingInline: cg.space[3],
    borderRadius: cg.radius.md,
    color: cg.textSecondary,
    textDecorationLine: 'none',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    transitionProperty: 'color, background-color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { color: cg.text, backgroundColor: `color-mix(in srgb, ${cg.text} 6%, transparent)` },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    [rail]: {
      flexDirection: 'column',
      justifyContent: 'center',
      minHeight: '56px',
      paddingInline: 0,
    },
  },
  active: { color: cg.text },
  pill: {
    position: 'absolute',
    inset: 0,
    borderRadius: cg.radius.md,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.solid} 16%, transparent)`,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 38%, transparent)`,
    boxShadow: `0 0 24px -10px ${cg.glow}`,
  },
  content: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    gap: cg.space[3],
    minWidth: 0,
    [rail]: { flexDirection: 'column', flex: '0 0 auto', gap: cg.space[1] },
  },
  icon: { display: 'inline-flex', fontSize: '20px', flexShrink: 0 },
  iconActive: { color: cg.tone.brand.fg },
  label: { [rail]: { fontSize: tokens.fontSizeBase100, lineHeight: '1.2' } },
  badge: {
    marginInlineStart: 'auto',
    minWidth: '22px',
    padding: '0 6px',
    borderRadius: cg.radius.pill,
    textAlign: 'center',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '20px',
    fontVariantNumeric: 'tabular-nums',
    color: cg.tone.neutral.fg,
    backgroundColor: cg.tone.neutral.tint,
    [rail]: { display: 'none' },
  },
  badgeWarning: { color: cg.tone.uncertain.fg, backgroundColor: cg.tone.uncertain.tint },
  badgeDanger: { color: cg.tone.unsupported.fg, backgroundColor: cg.tone.unsupported.tint },
  dot: {
    display: 'none',
    position: 'absolute',
    top: '8px',
    insetInlineEnd: '14px',
    width: '8px',
    height: '8px',
    borderRadius: cg.radius.pill,
    [rail]: { display: 'block' },
  },
  dotWarning: { backgroundColor: cg.tone.uncertain.solid },
  dotDanger: { backgroundColor: cg.tone.unsupported.solid },
  foot: { marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: cg.space[2] },
});

interface NavLinkProps {
  item: PrimaryNavItem;
  active: boolean;
  badge: NavBadge | undefined;
  layoutId: string;
}

function NavLink({ item, active, badge, layoutId }: NavLinkProps) {
  const styles = useStyles();
  const enabled = useMotionEnabled();
  const highlight = usePresenterHighlight(item.href);
  const Icon = item.icon;
  const tone = badge?.tone ?? 'neutral';
  return (
    <li>
      <UiLink
        href={item.href}
        aria-current={active ? 'page' : undefined}
        title={item.description}
        className={mergeClasses(
          styles.link,
          active && styles.active,
          highlight && 'cg-presenter-target',
        )}
      >
        {active ? (
          enabled ? (
            <m.span
              layoutId={layoutId}
              aria-hidden="true"
              className={styles.pill}
              transition={{ duration: motion.base / 1000, ease: motion.curve }}
            />
          ) : (
            <span aria-hidden="true" className={styles.pill} />
          )
        ) : null}
        <span className={styles.content}>
          <span
            aria-hidden="true"
            className={mergeClasses(styles.icon, active && styles.iconActive)}
          >
            <Icon />
          </span>
          <span className={styles.label}>{item.label}</span>
          {badge ? (
            <>
              <span
                aria-hidden="true"
                className={mergeClasses(
                  styles.badge,
                  tone === 'warning' && styles.badgeWarning,
                  tone === 'danger' && styles.badgeDanger,
                )}
              >
                {badge.text}
              </span>
              <span className="cg-sr-only">({badge.description})</span>
              {tone !== 'neutral' ? (
                <span
                  aria-hidden="true"
                  className={mergeClasses(
                    styles.dot,
                    tone === 'danger' ? styles.dotDanger : styles.dotWarning,
                  )}
                />
              ) : null}
            </>
          ) : null}
        </span>
      </UiLink>
    </li>
  );
}

/** The badge of each primary item: how many cases, how many open warnings, and a marker when the system is not healthy. */
function badgeFor(
  id: PrimaryNavItem['id'],
  badges: Readonly<Record<string, NavBadge>>,
): NavBadge | undefined {
  if (id === 'cases') return badges.cases;
  if (id === 'quality') return badges.quality;
  if (id === 'advanced' && badges.system) return badges.system;
  return undefined;
}

/**
 * The slim sidebar: the logo, the five places of the product, and the account. It is an icon rail below 1024 px and
 * gives way to the bottom bar below 768 px.
 */
export function Sidebar() {
  const styles = useStyles();
  const pathname = usePathname();
  const layoutId = useId();
  const { badges } = useNavBadges();
  return (
    <aside className={styles.root} aria-label="Sidebar">
      <UiLink href="/" className={styles.brand} aria-label="CaseGuard AI, Home">
        <span className={styles.wordmarkOnly}>
          <Logo />
        </span>
        <span className={styles.markOnly}>
          <Logo wordmark={false} />
        </span>
      </UiLink>
      <nav aria-label="Primary">
        <ul className={styles.list}>
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              active={item.isActive(pathname)}
              badge={badgeFor(item.id, badges)}
              layoutId={`${layoutId}-pill`}
            />
          ))}
        </ul>
      </nav>
      <div className={styles.foot}>
        <AccountMenu railHidesText />
      </div>
    </aside>
  );
}
