'use client';

import { cg, useThemeMode } from '@caseguard/ui';
import {
  Dialog,
  DialogSurface,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useActiveCase } from '../active-case';
import { queryKeys } from '../api/query-keys';
import { useApiQuery } from '../api/hooks';
import { useAuth } from '../auth/context';
import { useShortcut } from '../shortcuts';
import { useSingleKeyToggle } from '../shortcuts/use-single-key-toggle';
import { navContext } from '../nav';
import { usePresentation } from '../presentation';
import { useShellUi } from '../shell-ui';
import { useReducedMotionPreference } from '@caseguard/ui';
import {
  COMMAND_GROUP_ORDER,
  buildCaseCommands,
  buildNavigationCommands,
  buildPageCommands,
  buildPersonaCommands,
  type PaletteCommand,
} from './commands';
import { rankByQuery } from './fuzzy';

const useStyles = makeStyles({
  surface: {
    inset: '12vh 0 auto 0',
    maxWidth: '640px',
    width: 'calc(100% - 32px)',
    padding: 0,
    overflow: 'hidden',
    backgroundColor: cg.surfaceRaised,
    boxShadow: cg.shadowHigh,
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    color: cg.textSecondary,
  },
  input: {
    flex: 1,
    minWidth: 0,
    border: 'none',
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    color: cg.text,
    fontSize: tokens.fontSizeBase400,
    fontFamily: 'inherit',
    '::placeholder': { color: cg.textMuted },
  },
  list: { maxHeight: '50vh', overflowY: 'auto', padding: cg.space[2] },
  heading: {
    padding: `${cg.space[2]} ${cg.space[3]} ${cg.space[1]}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  option: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: cg.space[3],
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    cursor: 'pointer',
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
  },
  active: {
    backgroundColor: cg.tone.brand.tint,
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
  },
  hint: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '55%',
  },
  empty: {
    padding: cg.space[6],
    textAlign: 'center',
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  footer: {
    display: 'flex',
    gap: cg.space[4],
    padding: `${cg.space[2]} ${cg.space[4]}`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  mark: {
    backgroundColor: 'transparent',
    color: cg.textLink,
    fontWeight: tokens.fontWeightBold,
    textDecoration: 'underline',
  },
});

function Highlight({ text, indices }: { text: string; indices: readonly number[] }): ReactNode {
  if (indices.length === 0) return text;
  const hit = new Set(indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runHit = false;
  const flush = (key: number): void => {
    if (!run) return;
    parts.push(runHit ? <mark key={key}>{run}</mark> : <Fragment key={key}>{run}</Fragment>);
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

interface OptionProps {
  id: string;
  command: PaletteCommand;
  indices: readonly number[];
  active: boolean;
  showGroup?: boolean;
  onRun: (command: PaletteCommand) => void;
  onHover: () => void;
}

// A listbox option. Keyboard operation is on the combobox input (aria-activedescendant), so options are not focusable.
function Option({ id, command, indices, active, showGroup = false, onRun, onHover }: OptionProps) {
  const styles = useStyles();
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- activation is by Enter on the combobox input
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={mergeClasses(styles.option, active && styles.active)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun(command)}
      onMouseMove={onHover}
    >
      <span>
        <Highlight text={command.label} indices={indices} />
      </span>
      {command.hint || showGroup ? (
        <span className={styles.hint}>
          {showGroup ? `${command.group}${command.hint ? ` · ${command.hint}` : ''}` : command.hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Command palette (Ctrl/Cmd + K): navigation, cases, theme, development personas, presentation mode and safe actions.
 * A modal dialog with a combobox and a listbox: Up/Down move, Enter runs, Esc closes; focus is trapped and returns to
 * where it was.
 */
export function CommandPalette() {
  const styles = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { paletteOpen, setPaletteOpen, setShortcutsOpen, focusSearch } = useShellUi();
  const singleKey = useSingleKeyToggle();
  const { caseId, pathCaseId, setActiveCase } = useActiveCase();
  const auth = useAuth();
  const presentation = usePresentation();
  const theme = useThemeMode();
  const [motion, setMotion] = useReducedMotionPreference();
  const listId = useId();

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

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (href: string): void => router.push(href);
    const list: PaletteCommand[] = [
      ...buildNavigationCommands({
        context: navContext(pathname, caseId),
        navigate: go,
        showShortcuts: singleKey.enabled,
      }),
      ...buildPageCommands({ context: navContext(pathname, caseId), navigate: go }),
    ];
    list.push(
      ...buildCaseCommands({
        cases: cases.data?.items ?? [],
        openCase: (id) => {
          setActiveCase(id);
          const section = pathCaseId ? (/^\/cases\/[^/]+(\/.*)?$/.exec(pathname)?.[1] ?? '') : '';
          router.push(`/cases/${encodeURIComponent(id)}${section}`);
        },
      }),
    );
    for (const mode of ['light', 'dark', 'system'] as const) {
      if (theme.mode !== mode) {
        list.push({
          id: `theme:${mode}`,
          label: `Switch to ${mode} theme`,
          group: 'Appearance',
          keywords: 'theme colour appearance dark light system',
          run: () => theme.setMode(mode),
        });
      }
    }
    list.push({
      id: 'motion',
      label: motion === 'reduce' ? 'Follow the system motion setting' : 'Reduce motion',
      group: 'Appearance',
      keywords: 'animation accessibility motion',
      run: () => setMotion(motion === 'reduce' ? 'system' : 'reduce'),
    });
    if (auth.mode === 'dev' && auth.dev && !presentation.enabled) {
      const dev = auth.dev;
      list.push({
        id: 'persona:choose',
        label: 'Choose a development persona…',
        group: 'Identity',
        keywords: 'identity role sign in switch user',
        run: () => dev.openPicker(),
      });
      list.push(
        ...buildPersonaCommands({
          personas: personaQuery.data?.enabled ? personaQuery.data.items : [],
          currentPersonaId: dev.personaId,
          selectPersona: dev.selectPersona,
        }),
      );
    }
    list.push({
      id: 'presentation',
      label: presentation.enabled ? 'Turn off presentation mode' : 'Turn on presentation mode',
      group: 'Presentation',
      keywords: 'demo present presenter projector',
      run: () => presentation.toggle(),
    });
    list.push(
      {
        id: 'shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'Actions',
        ...(singleKey.enabled ? { hint: '?' } : {}),
        keywords: 'help keys',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'single-key-shortcuts',
        label: singleKey.enabled ? 'Turn single-key shortcuts off' : 'Turn single-key shortcuts on',
        group: 'Actions',
        keywords: 'keyboard accessibility shortcuts keys letters characters speech input',
        run: singleKey.toggle,
      },
      {
        id: 'search',
        label: 'Search cases, claims and skills',
        group: 'Actions',
        ...(singleKey.enabled ? { hint: '/' } : {}),
        keywords: 'find global search',
        run: () => window.setTimeout(focusSearch, 0),
      },
      {
        id: 'refresh',
        label: 'Refresh data on this page',
        group: 'Actions',
        keywords: 'reload invalidate',
        run: () =>
          void queryClient.invalidateQueries({ queryKey: queryKeys.identity(auth.identityKey) }),
      },
    );
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
    focusSearch,
    queryClient,
  ]);

  const [state, setState] = useState({ query: '', index: 0 });
  const ranked = useMemo(() => rankByQuery(state.query, commands), [state.query, commands]);
  const grouped = state.query.trim() === '';
  const ordered = useMemo(
    () =>
      grouped
        ? COMMAND_GROUP_ORDER.flatMap((group) => ranked.filter((r) => r.item.group === group))
        : ranked,
    [grouped, ranked],
  );
  const index = Math.min(state.index, Math.max(0, ordered.length - 1));
  const activeId = ordered[index] ? `${listId}-${ordered[index].item.id}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const close = (): void => {
    setPaletteOpen(false);
    setState({ query: '', index: 0 });
  };
  const run = (command: PaletteCommand): void => {
    close();
    command.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const count = ordered.length;
      if (count > 0) setState((s) => ({ ...s, index: (index + delta + count) % count }));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = ordered[index]?.item;
      if (command) run(command);
    }
  };

  return (
    <Dialog
      open={paletteOpen}
      onOpenChange={(_event, data) => (data.open ? setPaletteOpen(true) : close())}
    >
      <DialogSurface
        className={styles.surface}
        aria-label="Command palette"
        aria-describedby={undefined}
      >
        <div className={styles.searchRow}>
          <SearchRegular aria-hidden="true" />
          <input
            className={styles.input}
            type="text"
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            placeholder="Type a command, a destination or a case…"
            value={state.query}
            autoComplete="off"
            spellCheck={false}
            // A command palette is only useful with the cursor in its field; focus goes there the moment it opens.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setState({ query: event.target.value, index: 0 })}
            onKeyDown={onKeyDown}
          />
        </div>
        <div id={listId} role="listbox" aria-label="Commands" className={styles.list}>
          {ordered.length === 0 ? (
            <p className={styles.empty} role="status">
              No commands match “{state.query}”.
            </p>
          ) : grouped ? (
            COMMAND_GROUP_ORDER.map((group) => {
              const items = ordered.filter((r) => r.item.group === group);
              if (items.length === 0) return null;
              const headingId = `${listId}-group-${group}`;
              return (
                <div key={group} role="group" aria-labelledby={headingId}>
                  <div id={headingId} className={styles.heading} role="presentation">
                    {group}
                  </div>
                  {items.map((entry) => (
                    <Option
                      key={entry.item.id}
                      id={`${listId}-${entry.item.id}`}
                      command={entry.item}
                      indices={entry.indices}
                      active={ordered[index]?.item.id === entry.item.id}
                      onRun={run}
                      onHover={() => setState((s) => ({ ...s, index: ordered.indexOf(entry) }))}
                    />
                  ))}
                </div>
              );
            })
          ) : (
            ordered.map((entry, i) => (
              <Option
                key={entry.item.id}
                id={`${listId}-${entry.item.id}`}
                command={entry.item}
                indices={entry.indices}
                active={i === index}
                onRun={run}
                onHover={() => setState((s) => ({ ...s, index: i }))}
                showGroup
              />
            ))
          )}
        </div>
        <div className={styles.footer} aria-hidden="true">
          <span>↑↓ to move</span>
          <span>Enter to run</span>
          <span>Esc to close</span>
        </div>
      </DialogSurface>
    </Dialog>
  );
}
