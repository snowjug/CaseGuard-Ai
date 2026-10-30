'use client';

import { createPersistedStore, type PersistedStore } from '@caseguard/ui';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { eventToken, isSingleKeyShortcut, isTypingTarget, matchSequence, parseKeys } from './keys';

export interface ShortcutDef {
  /** Unique id; re-registering the same id replaces the definition. */
  id: string;
  /** `g c` (sequence), `/`, `?`, `mod+k` (Ctrl on Windows/Linux, Cmd on macOS). */
  keys: string;
  description: string;
  /** Heading in the help dialog, for example "Navigation". */
  group: string;
  handler: () => void;
  /** Disabled shortcuts are not matched and are not listed as available. */
  enabled?: boolean;
  /** Fire even while typing in an input (use for `mod+k` and Escape-like keys only). */
  allowInInput?: boolean;
  /** Fire while a modal dialog is open (use for opening help or the palette). */
  allowInModal?: boolean;
}

interface Registry {
  register: (definition: ShortcutDef) => () => void;
  list: () => ShortcutDef[];
}

const RegistryContext = createContext<Registry | null>(null);

export const SINGLE_KEY_STORAGE_KEY = 'cg-single-key-shortcuts';

/** Whether shortcuts typed with one character (`/`, `?`, `n`, `g c`) are on: on until the person turns them off. */
export function createSingleKeyStore(
  getStorage?: () => Storage | undefined,
): PersistedStore<boolean> {
  return createPersistedStore<boolean>({
    key: SINGLE_KEY_STORAGE_KEY,
    parse: (raw) => raw !== 'off',
    serialize: (value) => (value ? 'on' : 'off'),
    ...(getStorage ? { getStorage } : {}),
  });
}

const defaultSingleKeyStore = createSingleKeyStore();

export interface SingleKeyShortcutsState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const SingleKeyContext = createContext<SingleKeyShortcutsState>({
  enabled: true,
  setEnabled: () => undefined,
});

/** The "single-key shortcuts" setting (WCAG 2.1.4): when off, only shortcuts with Ctrl, Cmd or Alt work. */
export function useSingleKeyShortcuts(): SingleKeyShortcutsState {
  return useContext(SingleKeyContext);
}

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';

/**
 * Global keyboard shortcuts: single keys (`/`, `?`), modifier chords (`mod+k`) and Gmail-style sequences (`g` then `c`).
 * Shortcuts never fire while typing in a field or while a modal dialog is open, unless they opt in. Shortcuts made of
 * a character on its own can be turned off (`useSingleKeyShortcuts`, remembered in the browser); chords keep working.
 */
export function KeyboardShortcutsProvider({
  children,
  sequenceTimeoutMs = 1000,
  singleKeyStore = defaultSingleKeyStore,
}: {
  children: ReactNode;
  sequenceTimeoutMs?: number;
  singleKeyStore?: PersistedStore<boolean>;
}) {
  const definitions = useRef(new Map<string, ShortcutDef>());
  const singleKey = useSyncExternalStore(singleKeyStore.subscribe, singleKeyStore.get, () => true);
  const singleKeyState = useMemo<SingleKeyShortcutsState>(
    () => ({ enabled: singleKey, setEnabled: singleKeyStore.set }),
    [singleKey, singleKeyStore],
  );
  const registry = useMemo<Registry>(
    () => ({
      register: (definition) => {
        definitions.current.set(definition.id, definition);
        return () => {
          if (definitions.current.get(definition.id) === definition)
            definitions.current.delete(definition.id);
        };
      },
      list: () => [...definitions.current.values()].filter((d) => d.enabled !== false),
    }),
    [],
  );

  // Rebuilt when the setting changes, which also drops a half-typed sequence such as a `g` waiting for its second key.
  useEffect(() => {
    let buffer: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = (): void => {
      buffer = [];
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (['control', 'meta', 'shift', 'alt', 'altgraph'].includes(event.key.toLowerCase())) return;
      if (event.ctrlKey && event.altKey) return; // AltGr on many keyboard layouts
      const typing = isTypingTarget(event.target);
      const modal = document.querySelector(MODAL_SELECTOR) !== null;
      const candidates = [...definitions.current.values()].filter(
        (d) =>
          d.enabled !== false &&
          (singleKey || !isSingleKeyShortcut(d.keys)) &&
          (!typing || d.allowInInput === true) &&
          (!modal || d.allowInModal === true),
      );
      const attempt = (typed: string[]): { exact: ShortcutDef | undefined; prefix: boolean } => {
        let exact: ShortcutDef | undefined;
        let prefix = false;
        for (const candidate of candidates) {
          const match = matchSequence(typed, parseKeys(candidate.keys));
          if (match === 'exact') exact = candidate;
          else if (match === 'prefix') prefix = true;
        }
        return { exact, prefix };
      };

      const token = eventToken(event);
      let typed = [...buffer, token];
      let result = attempt(typed);
      if (!result.exact && !result.prefix && buffer.length > 0) {
        typed = [token];
        result = attempt(typed);
      }
      if (result.exact) {
        event.preventDefault();
        reset();
        result.exact.handler();
        return;
      }
      if (result.prefix) {
        buffer = typed;
        if (timer) clearTimeout(timer);
        timer = setTimeout(reset, sequenceTimeoutMs);
        return;
      }
      reset();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      reset();
    };
  }, [sequenceTimeoutMs, singleKey]);

  return (
    <RegistryContext.Provider value={registry}>
      <SingleKeyContext.Provider value={singleKeyState}>{children}</SingleKeyContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Registers a shortcut for the lifetime of the component. The latest `handler` is always the one called. */
export function useShortcut(definition: ShortcutDef): void {
  const registry = useContext(RegistryContext);
  const handler = useRef(definition.handler);
  useEffect(() => {
    handler.current = definition.handler;
  });
  const { id, keys, description, group, enabled, allowInInput, allowInModal } = definition;
  useEffect(() => {
    if (!registry) return undefined;
    return registry.register({
      id,
      keys,
      description,
      group,
      handler: () => handler.current(),
      ...(enabled === undefined ? {} : { enabled }),
      ...(allowInInput === undefined ? {} : { allowInInput }),
      ...(allowInModal === undefined ? {} : { allowInModal }),
    });
  }, [registry, id, keys, description, group, enabled, allowInInput, allowInModal]);
}

/** The shortcuts currently registered (for the help dialog). Call the returned function when opening the dialog. */
export function useShortcutList(): () => ShortcutDef[] {
  const registry = useContext(RegistryContext);
  return useMemo(() => () => registry?.list() ?? [], [registry]);
}

export { formatKeys, isSingleKeyShortcut } from './keys';
