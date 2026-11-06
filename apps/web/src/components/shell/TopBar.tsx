'use client';

import {
  IconButton,
  Kbd,
  Logo,
  ThemeToggle,
  UiLink,
  borderColors,
  cg,
  layout,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { SearchIcon } from 'lucide-react';
import { useShellUi } from '../../lib/shell-ui';
import { useIsMac } from '../../lib/use-is-mac';
import { AccountMenu } from './AccountMenu';
import { DemoDataPill } from './Notices';

const phone = `@media (max-width: ${layout.drawerBreakpoint - 1}px)`;

const useStyles = makeStyles({
  root: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    backgroundColor: `color-mix(in srgb, ${cg.canvas} 72%, transparent)`,
    backdropFilter: 'blur(16px) saturate(1.1)',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: `${layout.maxContentWidth + 2 * 32}px`,
    minHeight: `${layout.headerHeight}px`,
    marginInline: 'auto',
    paddingInline: cg.space[8],
    [phone]: { paddingInline: cg.space[4] },
  },
  brand: { display: 'none', textDecorationLine: 'none', [phone]: { display: 'inline-flex' } },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    boxSizing: 'border-box',
    width: 'min(420px, 100%)',
    minHeight: '40px',
    paddingInline: cg.space[3],
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.glass,
    color: cg.textMuted,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
    transitionProperty: 'border-color, color',
    transitionDuration: cg.motion.fast,
    ':hover': { color: cg.text, ...borderColors(cg.borderControl) },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    [phone]: { display: 'none' },
  },
  searchText: { flex: '1 1 auto', textAlign: 'start' },
  right: { display: 'flex', alignItems: 'center', gap: cg.space[2], marginInlineStart: 'auto' },
  phoneOnly: { display: 'none', [phone]: { display: 'inline-flex' } },
});

/** The shortcut hint: Cmd K on a Mac, Ctrl K elsewhere (server and first paint show Ctrl K). */
function ShortcutHint() {
  const mac = useIsMac();
  return <Kbd aria-hidden="true">{mac ? '⌘ K' : 'Ctrl K'}</Kbd>;
}

/**
 * The top bar (the page's `banner`): search and jump-to (Ctrl or Cmd + K) on the left, the demo-data marker and the
 * theme on the right. On a phone it carries the logo, a search button and the account menu, because the sidebar is gone.
 */
export function TopBar() {
  const styles = useStyles();
  const { setPaletteOpen } = useShellUi();
  return (
    <header className={styles.root}>
      <div className={styles.inner}>
        <UiLink href="/" className={styles.brand} aria-label="CaseGuard AI, Home">
          <Logo wordmark={false} />
        </UiLink>
        <button
          type="button"
          className={styles.search}
          aria-label="Search or jump to"
          title="Search or jump to (Ctrl K)"
          onClick={() => setPaletteOpen(true)}
        >
          <SearchIcon aria-hidden="true" />
          <span className={styles.searchText}>Search or jump to…</span>
          <ShortcutHint />
        </button>
        <div className={styles.right}>
          <DemoDataPill />
          <span className={styles.phoneOnly}>
            <IconButton icon={<SearchIcon />} label="Search" onClick={() => setPaletteOpen(true)} />
          </span>
          <ThemeToggle variant="icon" />
          <span className={mergeClasses(styles.phoneOnly)}>
            <AccountMenu compact />
          </span>
        </div>
      </div>
    </header>
  );
}
