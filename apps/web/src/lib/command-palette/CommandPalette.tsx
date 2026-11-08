'use client';

import type { SearchResult } from '@caseguard/schemas';
import { Kbd, cg, useReducedMotionPreference, useThemeMode } from '@caseguard/ui';
import { Dialog, DialogSurface, makeStyles, tokens } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { Command, useCommandState } from 'cmdk';
import {
  FolderOpenIcon,
  HistoryIcon,
  KeyboardIcon,
  LightbulbIcon,
  ListChecksIcon,
  MonitorIcon,
  MoonIcon,
  PresentationIcon,
  PuzzleIcon,
  SearchIcon,
  SunIcon,
  TriangleAlertIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useActiveCase } from '../active-case';
import { useApiQuery } from '../api/hooks';
import { describeError } from '../api/errors';
import { queryKeys } from '../api/query-keys';
import { useAuth } from '../auth/context';
import { navContext } from '../nav';
import { usePresentation } from '../presentation';
import { safeInternalHref } from '../safe-href';
import { useShellUi } from '../shell-ui';
import { useShortcut } from '../shortcuts';
import { useSingleKeyToggle } from '../shortcuts/use-single-key-toggle';
import {
  COMMAND_GROUP_ORDER,
  buildActionCommands,
  buildCaseCommands,
  buildNavigationCommands,
  buildPageCommands,
  buildPersonaCommands,
  type PaletteCommand,
} from './commands';
import { rankByQuery, type RankedItem } from './fuzzy';
import { usePaletteSearch } from './use-palette-search';

const phone = '@media (max-width: 767px)';
const coarse = '@media (pointer: coarse)';

const useStyles = makeStyles({
  surface: {
    inset: '12vh 0 auto 0',
    width: 'min(640px, calc(100% - 32px))',
    maxWidth: 'none',
    padding: 0,
    overflow: 'hidden',
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.xl,
    backgroundColor: cg.surfaceRaised,
    boxShadow: cg.shadowHigh,
    [phone]: { insetBlockStart: '8vh' },
  },
  backdrop: { backdropFilter: 'blur(4px)' },
  root: { display: 'flex', flexDirection: 'column', maxHeight: 'min(72vh, 560px)' },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '56px',
    paddingInline: cg.space[4],
    borderBottom: `1px solid ${cg.borderSubtle}`,
    color: cg.textMuted,
  },
  input: {
    flex: '1 1 auto',
    minWidth: 0,
    border: 'none',
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    color: cg.text,
    fontSize: tokens.fontSizeBase400,
    fontFamily: 'inherit',
    '::placeholder': { color: cg.textMuted },
  },
  list: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: cg.space[2],
    scrollPaddingBlock: cg.space[2],
  },
  heading: {
    display: 'block',
    padding: `${cg.space[3]} ${cg.space[3]} ${cg.space[1]}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '40px',
    padding: `${cg.space[1]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    cursor: 'pointer',
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    transitionProperty: 'background-color',
    transitionDuration: cg.motion.fast,
    '&[data-selected="true"]': { backgroundColor: cg.tone.brand.tint },
    [coarse]: { minHeight: '44px' },
  },
  icon: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.sm,
    backgroundColor: cg.surfaceSunken,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' },
  label: { overflowWrap: 'anywhere' },
  snippet: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hint: {
    flexShrink: 0,
    maxWidth: '45%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    [phone]: { display: 'none' },
  },
  mark: {
    backgroundColor: 'transparent',
    color: cg.tone.brand.fg,
    fontWeight: tokens.fontWeightSemibold,
  },
  status: {
    margin: 0,
    padding: `${cg.space[4]} ${cg.space[3]}`,
    textAlign: 'center',
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  footer: {
    display: 'flex',
    gap: cg.space[4],
    alignItems: 'center',
    padding: `${cg.space[2]} ${cg.space[4]}`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    [phone]: { display: 'none' },
  },
  footerItem: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
});

function Highlight({
  text,
  indices,
  className,
}: {
  text: string;
  indices: readonly number[];
  className: string;
}): ReactNode {
  if (indices.length === 0) return text;
  const hit = new Set(indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runHit = false;
  const flush = (key: number): void => {
    if (!run) return;
    parts.push(
      runHit ? (
        <mark key={key} className={className}>
          {run}
        </mark>
      ) : (
        <Fragment key={key}>{run}</Fragment>
      ),
    );
    run = '';
  };
  [...text].forEach((char, index) => {
    const isHit = hit.has(index);
    if (isHit !== runHit) {
      flush(index);
      runHit = isHit;
    }
    run += char;
  });
  flush(text.length);
  return parts;
}

interface RowProps {
  value: string;
  icon: LucideIcon | undefined;
  onRun: () => void;
  children: ReactNode;
  hint?: string | undefined;
}

/** One row of the list: an icon tile, the text (label and optional second line) and a muted hint on the right. */
function Row({ value, icon: Icon, onRun, children, hint }: RowProps) {
  const styles = useStyles();
  return (
    <Command.Item value={value} className={styles.item} onSelect={onRun}>
      <span className={styles.icon} aria-hidden="true">
        {Icon ? <Icon /> : <SearchIcon />}
      </span>
      <span className={styles.text}>{children}</span>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </Command.Item>
  );
}

function CommandRow({
  entry,
  showGroup,
  onRun,
}: {
  entry: RankedItem<PaletteCommand>;
  showGroup: boolean;
  onRun: (command: PaletteCommand) => void;
}) {
  const styles = useStyles();
  const { item } = entry;
  const hint = showGroup ? [item.group, item.hint].filter(Boolean).join(' · ') : item.hint;
  return (
    <Row value={`command:${item.id}`} icon={item.icon} hint={hint} onRun={() => onRun(item)}>
      <span className={styles.label}>
        <Highlight text={item.label} indices={entry.indices} className={styles.mark} />
      </span>
    </Row>
  );
}

/**
 * cmdk keeps `aria-activedescendant` in step with the selection when the keyboard or the pointer moves it, but not when
 * typing re-ranks the list: it reads the selected row from the page one render too early. Screen readers announce the
 * active option from this attribute, so it is set again from what is selected on the page.
 */
function ActiveOptionSync({ root }: { root: RefObject<HTMLElement | null> }) {
  const value = useCommandState((state) => state.value);
  const selectedItemId = useCommandState((state) => state.selectedItemId);
  useLayoutEffect(() => {
    const container = root.current;
    const input = container?.querySelector('[cmdk-input]');
    if (!input) return;
    const selected = container?.querySelector('[cmdk-item][aria-selected="true"]');
    if (selected?.id) input.setAttribute('aria-activedescendant', selected.id);
    else input.removeAttribute('aria-activedescendant');
  }, [root, value, selectedItemId]);
  return null;
}

const RESULT_ICONS: Record<SearchResult['type'], LucideIcon> = {
  case: FolderOpenIcon,
  claim: ListChecksIcon,
  hypothesis: LightbulbIcon,
  skill: PuzzleIcon,
  warning: TriangleAlertIcon,
  event: HistoryIcon,
};

const themeCommand = (
  mode: 'light' | 'dark' | 'system',
  setMode: (mode: 'light' | 'dark' | 'system') => void,
): PaletteCommand => {
  const label = {
    light: 'Switch to light theme',
    dark: 'Switch to dark theme',
    system: 'Use the system theme',
  }[mode];
  const icon: LucideIcon = { light: SunIcon, dark: MoonIcon, system: MonitorIcon }[mode];
  return {
    id: `theme:${mode}`,
    label,
    group: 'Preferences',
    icon,
    keywords: 'theme colour appearance dark light system',
    featured: mode !== 'system',
    run: () => setMode(mode),
  };
};

/**
 * Command palette and search (Ctrl or Cmd + K, or `/`): jump to any screen, add a case, open a case, change the theme,
 * switch the development persona, and search cases, claims and skills. A modal dialog around a combobox and a listbox:
 * Up and Down move, Enter runs, Escape closes; focus is trapped and returns to where it was.
 */
export function CommandPalette() {
  const styles = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { paletteOpen, setPaletteOpen, setShortcutsOpen } = useShellUi();
  const singleKey = useSingleKeyToggle();
  const { caseId, pathCaseId, setActiveCase } = useActiveCase();
  const auth = useAuth();
  const presentation = usePresentation();
  const theme = useThemeMode();
  const [motion, setMotion] = useReducedMotionPreference();
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const commandRef = useRef<HTMLDivElement | null>(null);

  // Typing always selects the first result, but cmdk scrolls to the row that was selected before the list was re-ranked,
  // which can leave the new first row above the visible part. Showing the top of the list after each change fixes that.
  useEffect(() => {
    if (!paletteOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [query, paletteOpen]);

  useShortcut({
    id: 'palette',
    keys: 'mod+k',
    description: 'Open the command palette',
    group: 'General',
    allowInInput: true,
    allowInModal: true,
    handler: () => setPaletteOpen(!paletteOpen),
  });

  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 25 } },
    { enabled: paletteOpen && auth.status === 'ready', staleTime: 30_000 },
  );
  const personaQuery = useApiQuery('dev.personas', undefined, {
    enabled: paletteOpen && auth.mode === 'dev' && !presentation.enabled,
    staleTime: 5 * 60_000,
  });
  const search = usePaletteSearch(query, paletteOpen);

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (href: string): void => router.push(href);
    const context = navContext(pathname, caseId);
    const list: PaletteCommand[] = [
      ...buildPageCommands({ context, navigate: go }),
      ...buildNavigationCommands({
        context,
        navigate: go,
        showShortcuts: singleKey.enabled,
        noCases: cases.data !== undefined && cases.data.items.length === 0,
      }),
      ...buildCaseCommands({
        cases: cases.data?.items ?? [],
        openCase: (id) => {
          setActiveCase(id);
          // On a case page the same tab stays open; anywhere else the review is where a case starts.
          const section = pathCaseId
            ? (/^\/cases\/[^/]+(\/.*)?$/.exec(pathname)?.[1] ?? '/review')
            : '/review';
          router.push(`/cases/${encodeURIComponent(id)}${section}`);
        },
      }),
      ...buildActionCommands({
        refresh: () =>
          void queryClient.invalidateQueries({ queryKey: queryKeys.identity(auth.identityKey) }),
      }),
    ];
    for (const mode of ['light', 'dark', 'system'] as const) {
      if (theme.mode !== mode) list.push(themeCommand(mode, theme.setMode));
    }
    list.push(
      {
        id: 'motion',
        label: motion === 'reduce' ? 'Follow the system motion setting' : 'Reduce motion',
        group: 'Preferences',
        icon: ZapIcon,
        keywords: 'animation accessibility motion',
        featured: true,
        run: () => setMotion(motion === 'reduce' ? 'system' : 'reduce'),
      },
      {
        id: 'presentation',
        label: presentation.enabled ? 'Turn off presentation mode' : 'Turn on presentation mode',
        group: 'Preferences',
        icon: PresentationIcon,
        keywords: 'demo present presenter projector',
        featured: true,
        run: () => presentation.toggle(),
      },
      {
        id: 'shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'Preferences',
        icon: KeyboardIcon,
        ...(singleKey.enabled ? { hint: '?' } : {}),
        keywords: 'help keys',
        featured: true,
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'single-key-shortcuts',
        label: singleKey.enabled ? 'Turn single-key shortcuts off' : 'Turn single-key shortcuts on',
        group: 'Preferences',
        icon: KeyboardIcon,
        keywords: 'keyboard accessibility shortcuts keys letters characters speech input',
        featured: false,
        run: singleKey.toggle,
      },
    );
    if (auth.mode === 'dev' && auth.dev && !presentation.enabled) {
      const dev = auth.dev;
      list.push(
        {
          id: 'persona:choose',
          label: 'Choose a development persona…',
          group: 'Account',
          keywords: 'identity role sign in switch user',
          featured: true,
          run: () => dev.openPicker(),
        },
        ...buildPersonaCommands({
          personas: personaQuery.data?.enabled ? personaQuery.data.items : [],
          currentPersonaId: dev.personaId,
          selectPersona: dev.selectPersona,
        }),
      );
    }
    return list;
  }, [
    router,
    pathname,
    caseId,
    pathCaseId,
    cases.data,
    theme,
    motion,
    setMotion,
    auth,
    presentation,
    personaQuery.data,
    setActiveCase,
    setShortcutsOpen,
    singleKey,
    queryClient,
  ]);

  const trimmed = query.trim();
  const searching = trimmed !== '';
  const ranked = useMemo(() => rankByQuery(trimmed, commands), [trimmed, commands]);
  // Before anything is typed the list is short and grouped; typing ranks every command, best match first.
  const shortList = useMemo(
    () =>
      COMMAND_GROUP_ORDER.map((group) => ({
        group,
        entries: ranked.filter(
          (entry) => entry.item.group === group && entry.item.featured !== false,
        ),
      })).filter((section) => section.entries.length > 0),
    [ranked],
  );

  const close = (): void => {
    setPaletteOpen(false);
    setQuery('');
  };
  const runCommand = (command: PaletteCommand): void => {
    close();
    command.run();
  };
  const openResult = (href: string): void => {
    const safe = safeInternalHref(href);
    if (!safe) return;
    close();
    router.push(safe);
  };

  const resultCount = search.groups.reduce((total, group) => total + group.items.length, 0);
  let status: string | null = null;
  if (searching && ranked.length === 0 && resultCount === 0) {
    status = search.pending
      ? 'Searching cases, claims and skills…'
      : search.error
        ? `Search failed. ${describeError(search.error)}`
        : `No results for “${trimmed}”.`;
  } else if (search.pending) status = 'Searching cases, claims and skills…';
  else if (search.error) status = `Search failed. ${describeError(search.error)}`;

  return (
    <Dialog
      open={paletteOpen}
      onOpenChange={(_event, data) => (data.open ? setPaletteOpen(true) : close())}
    >
      <DialogSurface
        className={styles.surface}
        backdrop={{ className: styles.backdrop }}
        aria-label="Command palette"
        aria-describedby={undefined}
      >
        <Command
          ref={commandRef}
          className={styles.root}
          label="Search commands"
          shouldFilter={false}
          loop
          vimBindings={false}
        >
          <ActiveOptionSync root={commandRef} />
          <div className={styles.searchRow}>
            <SearchIcon aria-hidden="true" />
            <Command.Input
              className={styles.input}
              value={query}
              onValueChange={setQuery}
              placeholder="Search or jump to…"
              maxLength={200}
              // A command palette is only useful with the cursor in its field; focus goes there the moment it opens.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <Kbd aria-hidden="true">Esc</Kbd>
          </div>
          <Command.List ref={listRef} className={styles.list} label="Commands and search results">
            {status ? (
              <p className={styles.status} role="status">
                {status}
              </p>
            ) : null}
            {searching
              ? ranked.map((entry) => (
                  <CommandRow key={entry.item.id} entry={entry} showGroup onRun={runCommand} />
                ))
              : shortList.map((section) => (
                  <Command.Group
                    key={section.group}
                    heading={<span className={styles.heading}>{section.group}</span>}
                  >
                    {section.entries.map((entry) => (
                      <CommandRow
                        key={entry.item.id}
                        entry={entry}
                        showGroup={false}
                        onRun={runCommand}
                      />
                    ))}
                  </Command.Group>
                ))}
            {search.groups.map((group) => (
              <Command.Group
                key={group.type}
                heading={<span className={styles.heading}>{group.label}</span>}
              >
                {group.items.map((item) => (
                  <Row
                    key={`${item.type}:${item.id}`}
                    value={`result:${item.type}:${item.id}`}
                    icon={RESULT_ICONS[item.type]}
                    onRun={() => openResult(item.href)}
                  >
                    <span className={styles.label}>{item.title}</span>
                    {item.snippet ? <span className={styles.snippet}>{item.snippet}</span> : null}
                  </Row>
                ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className={styles.footer} aria-hidden="true">
            <span className={styles.footerItem}>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className={styles.footerItem}>
              <Kbd>Enter</Kbd> to open
            </span>
            <span className={styles.footerItem}>
              <Kbd>Esc</Kbd> to close
            </span>
          </div>
        </Command>
      </DialogSurface>
    </Dialog>
  );
}
