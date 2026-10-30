'use client';

import { VisuallyHidden, cg, layout } from '@caseguard/ui';
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useActiveCase } from '../../lib/active-case';
import { NAV_ITEMS, navContext, type NavItem } from '../../lib/nav';
import { useNavBadges, type NavBadge } from '../../lib/nav-badges';
import { usePresenterHighlight } from '../../lib/presentation';
import { useShellUi } from '../../lib/shell-ui';
import { useSwitchCase } from '../../lib/use-switch-case';
import { CaseSelect } from '../common/CaseSelect';

const GROUPS: { label: string; ids: readonly string[] }[] = [
  { label: 'Overview', ids: ['command-center'] },
  { label: 'Investigate', ids: ['cases', 'timeline', 'evidence', 'hypotheses', 'counterfactual'] },
  { label: 'Improve', ids: ['quality', 'skills', 'efficiency'] },
  { label: 'Operate', ids: ['governance', 'system', 'demo'] },
];

const useStyles = makeStyles({
  nav: {
    position: 'sticky',
    top: 'var(--cg-shell-top, 84px)',
    alignSelf: 'flex-start',
    flexShrink: 0,
    width: `${layout.navWidth}px`,
    height: 'calc(100dvh - var(--cg-shell-top, 84px))',
    overflowY: 'auto',
    padding: `${cg.space[4]} ${cg.space[3]}`,
    borderRight: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: {
      width: `${layout.navRailWidth}px`,
      padding: `${cg.space[3]} ${cg.space[2]}`,
    },
    [`@media (max-width: ${layout.drawerBreakpoint - 1}px)`]: { display: 'none' },
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  groups: { display: 'flex', flexDirection: 'column' },
  caption: {
    margin: `${cg.space[3]} 0 ${cg.space[1]}`,
    padding: `0 ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  captionRail: { [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: { display: 'none' } },
  divider: {
    display: 'none',
    height: '1px',
    margin: `${cg.space[2]} ${cg.space[2]}`,
    backgroundColor: cg.borderSubtle,
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: { display: 'block' },
  },
  link: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '40px',
    padding: `${cg.space[1]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    color: cg.text,
    textDecorationLine: 'none',
    fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: cg.surfaceSunken },
  },
  // The icon rail only applies to the persistent sidebar; the drawer always shows full labels.
  linkRail: {
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: {
      justifyContent: 'center',
      padding: 0,
    },
  },
  active: {
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontWeight: tokens.fontWeightSemibold,
    '::before': {
      content: '""',
      position: 'absolute',
      left: '0',
      top: '8px',
      bottom: '8px',
      width: '3px',
      borderRadius: '2px',
      backgroundColor: cg.tone.brand.solid,
    },
  },
  muted: { color: cg.textSecondary },
  icon: { display: 'inline-flex', flexShrink: 0, fontSize: '20px' },
  text: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flexGrow: 1,
    lineHeight: tokens.lineHeightBase300,
  },
  textRail: { [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: { display: 'none' } },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  note: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightRegular,
    color: cg.textMuted,
  },
  drawerCase: { marginBottom: cg.space[4] },
  badge: {
    flexShrink: 0,
    minWidth: '22px',
    padding: '0 6px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.tone.neutral.border}`,
    backgroundColor: cg.tone.neutral.tint,
    color: cg.tone.neutral.fg,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '18px',
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  },
  badgeWarning: {
    border: `1px solid ${cg.tone.uncertain.border}`,
    backgroundColor: cg.tone.uncertain.tint,
    color: cg.tone.uncertain.fg,
  },
  badgeDanger: {
    border: `1px solid ${cg.tone.unsupported.border}`,
    backgroundColor: cg.tone.unsupported.tint,
    color: cg.tone.unsupported.fg,
  },
  badgeRail: { [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: { display: 'none' } },
  // In the icon rail there is no room for the figure, so a warning is a dot on the icon (the sentence is still read).
  dot: {
    display: 'none',
    position: 'absolute',
    top: '6px',
    right: '12px',
    width: '10px',
    height: '10px',
    borderRadius: cg.radius.pill,
    border: `2px solid ${cg.surface}`,
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: { display: 'block' },
  },
  dotWarning: { backgroundColor: cg.tone.uncertain.solid },
  dotDanger: { backgroundColor: cg.tone.unsupported.solid },
});

interface NavLinkProps {
  item: NavItem;
  pathname: string;
  context: ReturnType<typeof navContext>;
  inDrawer: boolean;
  onNavigate?: () => void;
  badge?: NavBadge | undefined;
  /** True once the case list loaded and is empty. */
  noCases?: boolean;
}

function NavLink({
  item,
  pathname,
  context,
  inDrawer,
  onNavigate,
  badge,
  noCases = false,
}: NavLinkProps) {
  const styles = useStyles();
  const href = item.href(context);
  const active = item.isActive(pathname);
  const highlight = usePresenterHighlight(href);
  const needsCase = item.scope === 'case' && !context.caseId;
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        title={needsCase ? `${item.label}: choose a case first` : item.label}
        className={mergeClasses(
          styles.link,
          !inDrawer && styles.linkRail,
          active && styles.active,
          needsCase && !active && styles.muted,
          highlight && 'cg-presenter-target',
        )}
        onClick={onNavigate}
      >
        <span aria-hidden="true" className={styles.icon}>
          <Icon />
        </span>
        <span className={mergeClasses(styles.text, !inDrawer && styles.textRail)}>
          <span className={styles.label}>{item.label}</span>
          {needsCase ? (
            <span className={styles.note}>
              <VisuallyHidden>
                {noCases ? '(no cases yet: ingest one first)' : '(choose a case first)'}
              </VisuallyHidden>
              <span aria-hidden="true">{noCases ? 'No cases yet' : 'Needs a case'}</span>
            </span>
          ) : null}
        </span>
        {badge ? (
          <>
            <span
              aria-hidden="true"
              className={mergeClasses(
                styles.badge,
                badge.tone === 'warning' && styles.badgeWarning,
                badge.tone === 'danger' && styles.badgeDanger,
                !inDrawer && styles.badgeRail,
              )}
            >
              {badge.text}
            </span>
            <VisuallyHidden>({badge.description})</VisuallyHidden>
            {!inDrawer && badge.tone !== 'neutral' ? (
              <span
                aria-hidden="true"
                className={mergeClasses(
                  styles.dot,
                  badge.tone === 'danger' ? styles.dotDanger : styles.dotWarning,
                )}
              />
            ) : null}
          </>
        ) : null}
      </Link>
    </li>
  );
}

function NavList({ inDrawer, onNavigate }: { inDrawer: boolean; onNavigate?: () => void }) {
  const styles = useStyles();
  const pathname = usePathname();
  const { caseId } = useActiveCase();
  const { badges, noCases } = useNavBadges();
  const context = navContext(pathname, caseId);
  return (
    <div className={styles.groups}>
      {GROUPS.map((group, groupIndex) => (
        <div key={group.label}>
          {groupIndex > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
          <p
            className={mergeClasses(styles.caption, !inDrawer && styles.captionRail)}
            aria-hidden="true"
          >
            {group.label}
          </p>
          <ul className={styles.list} aria-label={group.label}>
            {group.ids.map((id) => {
              const item = NAV_ITEMS.find((candidate) => candidate.id === id);
              return item ? (
                <NavLink
                  key={id}
                  item={item}
                  pathname={pathname}
                  context={context}
                  inDrawer={inDrawer}
                  badge={badges[id]}
                  noCases={noCases}
                  {...(onNavigate ? { onNavigate } : {})}
                />
              ) : null;
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Primary navigation: all 12 destinations; icon rail below 1100 px; a drawer below 720 px (see `NavDrawer`). */
export function SideNav() {
  const styles = useStyles();
  return (
    <nav aria-label="Primary" className={styles.nav}>
      <NavList inDrawer={false} />
    </nav>
  );
}

/** Mobile navigation drawer, opened from the header's menu button. It also holds the case switcher, which the header hides on small screens. */
export function NavDrawer() {
  const styles = useStyles();
  const { navOpen, setNavOpen } = useShellUi();
  const { caseId } = useActiveCase();
  const switchCase = useSwitchCase();
  return (
    <OverlayDrawer
      open={navOpen}
      onOpenChange={(_event, data) => setNavOpen(data.open)}
      position="start"
      size="small"
      aria-label="Navigation"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              aria-label="Close navigation"
              icon={<DismissRegular />}
              onClick={() => setNavOpen(false)}
            />
          }
        >
          Navigation
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.drawerCase}>
          <CaseSelect
            label="Active case"
            value={caseId}
            onChange={(id) => {
              switchCase(id);
              setNavOpen(false);
            }}
          />
        </div>
        <nav aria-label="Primary">
          <NavList inDrawer onNavigate={() => setNavOpen(false)} />
        </nav>
      </DrawerBody>
    </OverlayDrawer>
  );
}
