'use client';

import { cg } from '@caseguard/ui';
import type { SearchResult } from '@caseguard/schemas';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { describeError } from '../api/errors';
import { useApiQuery } from '../api/hooks';
import { useAuth } from '../auth/context';
import { safeInternalHref } from '../safe-href';
import { useShellUi } from '../shell-ui';
import { useSingleKeyShortcuts } from '../shortcuts';
import { useDebouncedValue } from '../use-debounced-value';

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  case: 'Cases',
  claim: 'Claims',
  hypothesis: 'Hypotheses',
  skill: 'Skills',
  warning: 'Warnings',
  event: 'Events',
};
const TYPE_ORDER: readonly SearchResult['type'][] = [
  'case',
  'hypothesis',
  'claim',
  'skill',
  'warning',
  'event',
];

const useStyles = makeStyles({
  root: { position: 'relative', width: '100%', maxWidth: '460px', minWidth: 0 },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    height: '36px',
    padding: `0 ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    ':focus-within': { outline: `2px solid ${cg.focus}`, outlineOffset: '1px' },
  },
  input: {
    flex: 1,
    minWidth: 0,
    border: 'none',
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    color: cg.text,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    '::placeholder': { color: cg.textMuted },
  },
  key: {
    flexShrink: 0,
    padding: '0 6px',
    borderRadius: cg.radius.sm,
    border: `1px solid ${cg.borderControl}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontFamily: cg.font.mono,
  },
  popup: {
    position: 'absolute',
    insetInline: 0,
    top: 'calc(100% + 6px)',
    zIndex: 30,
    maxHeight: '60vh',
    overflowY: 'auto',
    padding: cg.space[2],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceRaised,
    boxShadow: cg.shadowHigh,
  },
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
    flexDirection: 'column',
    gap: '2px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    cursor: 'pointer',
    color: cg.text,
  },
  active: {
    backgroundColor: cg.tone.brand.tint,
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
  },
  title: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  snippet: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary, overflowWrap: 'anywhere' },
  status: {
    margin: 0,
    padding: cg.space[3],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
});

/** Groups results by type in a fixed order; the flat list defines keyboard order. Exported for tests. */
export function groupResults(
  items: readonly SearchResult[],
): { type: SearchResult['type']; label: string; items: SearchResult[] }[] {
  return TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABELS[type],
    items: items.filter((item) => item.type === type),
  })).filter((group) => group.items.length > 0);
}

/**
 * Global search (`/` focuses it). Debounced `search.global` (tenant-scoped on the server), results grouped by type,
 * keyboard operable (Up/Down, Enter, Esc) as an ARIA combobox with a listbox.
 */
export function GlobalSearch() {
  const styles = useStyles();
  const router = useRouter();
  const auth = useAuth();
  const { registerSearchInput } = useShellUi();
  const { enabled: singleKey } = useSingleKeyShortcuts();
  const listId = useId();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(query.trim(), 250);
  const ready = auth.status === 'ready' && debounced.length >= 2;
  const results = useApiQuery(
    'search.global',
    { query: { q: debounced, limit: 10 } },
    { enabled: ready, staleTime: 30_000 },
  );

  const groups = useMemo(() => groupResults(results.data?.items ?? []), [results.data]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const activeItem = flat[index];
  const optionId = (item: SearchResult): string => `${listId}-${item.type}-${item.id}`;
  const showPopup = open && query.trim().length > 0;
  const typing = query.trim() !== debounced;

  useEffect(() => {
    if (showPopup && activeItem)
      document.getElementById(optionId(activeItem))?.scrollIntoView({ block: 'nearest' });
    // optionId depends only on listId and the item
  }, [showPopup, activeItem]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (item: SearchResult): void => {
    const href = safeInternalHref(item.href);
    if (!href) return;
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const count = flat.length;
      if (count > 0) setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {
      if (showPopup && activeItem) {
        event.preventDefault();
        choose(activeItem);
      }
    } else if (event.key === 'Escape') {
      if (showPopup) {
        event.preventDefault();
        setOpen(false);
      } else if (query) {
        event.preventDefault();
        setQuery('');
      }
    }
  };

  let status: string | null = null;
  if (query.trim().length < 2) status = 'Type at least 2 characters to search.';
  else if (auth.status !== 'ready') status = 'Choose an identity to search.';
  else if (typing || results.isFetching) status = 'Searching…';
  else if (results.isError) status = `Search failed. ${describeError(results.error)}`;
  else if (flat.length === 0) status = `No results for “${debounced}”.`;

  return (
    <div
      ref={wrapper}
      className={styles.root}
      role="search"
      onBlur={(event) => {
        if (!wrapper.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={styles.field}>
        <SearchRegular aria-hidden="true" />
        <input
          ref={registerSearchInput}
          className={styles.input}
          type="text"
          role="combobox"
          aria-label="Search cases, claims, hypotheses and skills"
          aria-expanded={showPopup}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPopup && activeItem ? optionId(activeItem) : undefined}
          placeholder="Search cases, claims, skills…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {singleKey ? (
          <kbd className={styles.key} aria-hidden="true">
            /
          </kbd>
        ) : null}
      </div>
      {showPopup ? (
        <div className={styles.popup}>
          {status ? (
            <p className={styles.status} role="status">
              {status}
            </p>
          ) : null}
          <div id={listId} role="listbox" aria-label="Search results" hidden={flat.length === 0}>
            {groups.map((group) => (
              <div key={group.type} role="group" aria-labelledby={`${listId}-${group.type}`}>
                <div id={`${listId}-${group.type}`} className={styles.heading} role="presentation">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter is handled on the combobox input
                  <div
                    key={optionId(item)}
                    id={optionId(item)}
                    role="option"
                    aria-selected={item === activeItem}
                    tabIndex={-1}
                    className={mergeClasses(styles.option, item === activeItem && styles.active)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setActive(flat.indexOf(item))}
                    onClick={() => choose(item)}
                  >
                    <span className={styles.title}>{item.title}</span>
                    {item.snippet ? <span className={styles.snippet}>{item.snippet}</span> : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
