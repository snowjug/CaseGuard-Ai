'use client';

import { cg, layout } from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { CommandPalette } from '../../lib/command-palette/CommandPalette';
import { useActiveCase } from '../../lib/active-case';
import { PersonaPickerDialog } from '../../lib/auth/dev-persona';
import { BreadcrumbLabelsProvider } from '../../lib/breadcrumbs';
import { NAV_ITEMS, navContext } from '../../lib/nav';
import { usePresentation } from '../../lib/presentation';
import {
  PRESENTER_HEIGHT_FALLBACK_PX,
  PRESENTER_HEIGHT_VAR,
} from '../../lib/presentation/presenter-height';
import { ShellUiProvider, useShellUi } from '../../lib/shell-ui';
import { useShortcut } from '../../lib/shortcuts';
import { BottomBar } from './BottomBar';
import { Breadcrumbs } from './Breadcrumbs';
import { Footer } from './Notices';
import { PresenterStrip } from './PresenterStrip';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const phone = `@media (max-width: ${layout.drawerBreakpoint - 1}px)`;
const narrow = `@media (max-width: ${layout.railBreakpoint - 1}px)`;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    minHeight: '100dvh',
    backgroundColor: cg.canvas,
    color: cg.text,
  },
  // The soft violet wash behind the page: depth without weight, fixed so it stays while the page scrolls.
  aurora: {
    position: 'fixed',
    insetInline: 0,
    top: 0,
    height: '560px',
    zIndex: 0,
    pointerEvents: 'none',
    backgroundImage: cg.aurora,
  },
  frame: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'flex-start',
    minHeight: '100dvh',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: '100dvh',
  },
  main: {
    flex: '1 0 auto',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: `${layout.maxContentWidth + 2 * 32}px`,
    marginInline: 'auto',
    outlineStyle: 'none',
    padding: `${cg.space[6]} ${cg.space[8]} 0`,
    [narrow]: { paddingInline: cg.space[6] },
    [phone]: { paddingInline: cg.space[4], paddingTop: cg.space[4] },
  },
  footerWrap: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: `${layout.maxContentWidth + 2 * 32}px`,
    marginInline: 'auto',
    padding: `0 ${cg.space[8]} ${cg.space[8]}`,
    [narrow]: { paddingInline: cg.space[6] },
    [phone]: {
      paddingInline: cg.space[4],
      paddingBottom: `calc(${layout.bottomBarHeight}px + env(safe-area-inset-bottom) + ${cg.space[6]})`,
    },
  },
  presenting: {
    paddingBottom: `var(${PRESENTER_HEIGHT_VAR}, ${PRESENTER_HEIGHT_FALLBACK_PX}px)`,
  },
});

/** `g` then the destination's key (for example `g c` for Cases). One component per item because hooks cannot run in a loop. */
function NavShortcut({ index }: { index: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const { caseId } = useActiveCase();
  const item = NAV_ITEMS[index];
  const context = navContext(pathname, caseId);
  useShortcut({
    id: `nav:${item?.id ?? index}`,
    keys: `g ${item?.shortcutKey ?? ''}`,
    description: `Go to ${item?.label ?? ''}`,
    group: 'Navigation',
    enabled: item !== undefined,
    handler: () => {
      if (item) router.push(item.href(context));
    },
  });
  return null;
}

function GlobalShortcuts() {
  const { openSearch, setShortcutsOpen } = useShellUi();
  useShortcut({
    id: 'search',
    keys: '/',
    description: 'Search cases, claims and skills',
    group: 'General',
    handler: openSearch,
  });
  useShortcut({
    id: 'help',
    keys: '?',
    description: 'Show keyboard shortcuts',
    group: 'General',
    handler: () => setShortcutsOpen(true),
  });
  return (
    <>
      {NAV_ITEMS.map((item, index) => (
        <NavShortcut key={item.id} index={index} />
      ))}
    </>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const pathname = usePathname();
  const presentation = usePresentation();
  const main = useRef<HTMLElement | null>(null);
  const previousPath = useRef(pathname);

  // After a client-side navigation, move focus to the main region so keyboard and screen-reader users start at the new
  // page. Comparing paths (not "is this the first run") keeps React StrictMode's double effect from stealing focus on load.
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div
      className={mergeClasses(styles.root, presentation.enabled && styles.presenting)}
      style={{ '--cg-shell-top': `${layout.headerHeight}px` } as CSSProperties}
    >
      <a className="cg-skip-link" href="#main-content">
        Skip to main content
      </a>
      <div aria-hidden="true" className={styles.aurora} />
      <div className={styles.frame}>
        <Sidebar />
        <div className={styles.column}>
          <TopBar />
          <main id="main-content" ref={main} tabIndex={-1} className={styles.main}>
            <Breadcrumbs />
            {children}
          </main>
          <div className={styles.footerWrap}>
            <Footer />
          </div>
        </div>
      </div>
      <BottomBar />
      <CommandPalette />
      <ShortcutsDialog />
      <PersonaPickerDialog />
      <PresenterStrip />
      <GlobalShortcuts />
    </div>
  );
}

/**
 * The application frame: skip link, slim sidebar (bottom bar on a phone), top bar, breadcrumbs, `main`, footer and the
 * overlays (command palette, shortcut help, persona picker, presenter strip). Used by `app/(shell)/layout.tsx`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ShellUiProvider>
      <BreadcrumbLabelsProvider>
        <ShellFrame>{children}</ShellFrame>
      </BreadcrumbLabelsProvider>
    </ShellUiProvider>
  );
}
