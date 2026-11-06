'use client';

import { UiLink, cg, layout, motion, useMotionEnabled } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { motion as m } from 'motion/react';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { PRIMARY_NAV } from '../../lib/nav';
import { useNavBadges } from '../../lib/nav-badges';
import { usePresenterHighlight } from '../../lib/presentation';

const useStyles = makeStyles({
  root: {
    display: 'none',
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    zIndex: 20,
    boxSizing: 'border-box',
    minHeight: `${layout.bottomBarHeight}px`,
    paddingBottom: 'env(safe-area-inset-bottom)',
    borderTop: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.glass,
    backdropFilter: 'blur(16px) saturate(1.1)',
    [`@media (max-width: ${layout.drawerBreakpoint - 1}px)`]: { display: 'block' },
  },
  list: {
    display: 'grid',
    gridTemplateColumns: `repeat(${PRIMARY_NAV.length}, 1fr)`,
    margin: 0,
    padding: `${cg.space[1]} ${cg.space[2]}`,
    listStyleType: 'none',
  },
  link: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    minHeight: '56px',
    borderRadius: cg.radius.md,
    color: cg.textSecondary,
    textDecorationLine: 'none',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightMedium,
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
  },
  active: { color: cg.text },
  pill: {
    position: 'absolute',
    inset: '2px 6px',
    borderRadius: cg.radius.md,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.solid} 16%, transparent)`,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 38%, transparent)`,
  },
  stack: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
  },
  icon: { display: 'inline-flex', fontSize: '22px' },
  iconActive: { color: cg.tone.brand.fg },
  dot: {
    position: 'absolute',
    top: '-2px',
    insetInlineEnd: '-6px',
    width: '8px',
    height: '8px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.uncertain.solid,
  },
});

function BarLink({ id, layoutId }: { id: (typeof PRIMARY_NAV)[number]['id']; layoutId: string }) {
  const styles = useStyles();
  const pathname = usePathname();
  const enabled = useMotionEnabled();
  const { badges } = useNavBadges();
  const item = PRIMARY_NAV.find((candidate) => candidate.id === id);
  const highlight = usePresenterHighlight(item?.href ?? '/');
  if (!item) return null;
  const active = item.isActive(pathname);
  const Icon = item.icon;
  const attention =
    (id === 'quality' && badges.quality?.tone === 'warning') ||
    (id === 'advanced' && badges.system && badges.system.tone !== 'neutral');
  return (
    <li>
      <UiLink
        href={item.href}
        aria-current={active ? 'page' : undefined}
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
        <span className={styles.stack}>
          <span
            aria-hidden="true"
            className={mergeClasses(styles.icon, active && styles.iconActive)}
          >
            <Icon />
          </span>
          {attention ? <span aria-hidden="true" className={styles.dot} /> : null}
          <span>{item.label}</span>
        </span>
      </UiLink>
    </li>
  );
}

/** The five places of the product as a bottom bar on a phone: icon and word, one thumb away. */
export function BottomBar() {
  const styles = useStyles();
  const layoutId = useId();
  return (
    <nav aria-label="Primary, mobile" className={styles.root}>
      <ul className={styles.list}>
        {PRIMARY_NAV.map((item) => (
          <BarLink key={item.id} id={item.id} layoutId={`${layoutId}-pill`} />
        ))}
      </ul>
    </nav>
  );
}
