'use client';

import { cg, layout, useElementSize } from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { CommandPalette } from '../../lib/command-palette/CommandPalette';
import { useActiveCase } from '../../lib/active-case';
import { PersonaPickerDialog } from '../../lib/auth/dev-persona';
import { BreadcrumbLabelsProvider } from '../../lib/breadcrumbs';
import { NAV_ITEMS, navContext } from '../../lib/nav';
import { usePresentation } from '../../lib/presentation';
import { ShellUiProvider, useShellUi } from '../../lib/shell-ui';
import { useShortcut } from '../../lib/shortcuts';
import { Breadcrumbs } from './Breadcrumbs';
import { Header } from './Header';
import { Footer } from './Notices';
import { PresenterStrip } from './PresenterStrip';
import { ShortcutsDialog } from './ShortcutsDialog';
import { NavDrawer, SideNav } from './SideNav';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100dvh',
    backgroundColor: cg.canvas,
    color: cg.text,
  },
  top: {
    position: 'relative',
    zIndex: 10,
    [`@media (min-width: ${layout.drawerBreakpoint}px)`]: { position: 'sticky', top: 0 },
  },
  body: { display: 'flex', flex: '1 0 auto', alignItems: 'flex-start', width: '100%', minWidth: 0 },
  main: {
    flex: '1 1 0',
    minWidth: 0,
    outlineStyle: 'none',
    padding: `${cg.space[6]} ${cg.space[8]} ${cg.space[8]}`,
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: {
      padding: `${cg.space[4]} ${cg.space[6]} ${cg.space[6]}`,
    },
    [`@media (max-width: ${layout.mobileBreakpoint - 1}px)`]: {
      padding: `${cg.space[3]} ${cg.space[4]} ${cg.space[6]}`,
    },
  },
  content: { width: '100%', maxWidth: `${layout.maxContentWidth}px`, marginInline: 'auto' },
  presenting: { paddingBottom: 'var(--cg-presenter-height, 104px)' },
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
  const { focusSearch, setShortcutsOpen } = useShellUi();
  useShortcut({
    id: 'search',
    keys: '/',
    description: 'Search cases, claims and skills',
    group: 'General',
    handler: focusSearch,
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
  const [topRef, topSize] = useElementSize<HTMLDivElement>({ width: 0, height: 84 });
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
      style={{ '--cg-shell-top': `${topSize.height}px` } as CSSProperties}
    >
      <a className="cg-skip-link" href="#main-content">
        Skip to main content
      </a>
      <div ref={topRef} className={styles.top}>
        <Header />
      </div>
      <div className={styles.body}>
        <SideNav />
        <main id="main-content" ref={main} tabIndex={-1} className={styles.main}>
          <div className={styles.content}>
            <Breadcrumbs />
            {children}
          </div>
        </main>
      </div>
      <Footer />
      <NavDrawer />
      <CommandPalette />
      <ShortcutsDialog />
      <PersonaPickerDialog />
      <PresenterStrip />
      <GlobalShortcuts />
    </div>
  );
}

/**
 * The application frame: skip link, honesty bar, header, primary navigation, breadcrumbs, `main`, footer and the
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
