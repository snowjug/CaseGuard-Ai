'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ShellUiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  /** Mobile navigation drawer. */
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
  /** The header search input registers itself so the `/` shortcut can focus it. */
  registerSearchInput: (element: HTMLInputElement | null) => void;
  focusSearch: () => void;
}

const ShellUiContext = createContext<ShellUiState | null>(null);

/**
 * Open state of one overlay that returns focus to whatever had it when the overlay opened (the button that was
 * clicked, or the element that was focused when a shortcut fired). Fluent only restores focus for triggers it renders.
 */
function useOverlay(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(false);
  const isOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (next === isOpen.current) return;
    isOpen.current = next;
    if (next) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    } else {
      const target = opener.current;
      opener.current = null;
      if (target) {
        // Wait for the dialog to unmount so Fluent's focus trap cannot take the focus back.
        window.setTimeout(() => {
          if (target.isConnected) target.focus();
        }, 0);
      }
    }
    setOpenState(next);
  }, []);
  return [open, setOpen] as const;
}

/** Open/close state for the shell's overlays (command palette, shortcut help, navigation drawer) and search focus. */
export function ShellUiProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useOverlay();
  const [shortcutsOpen, setShortcutsOpen] = useOverlay();
  const [navOpen, setNavOpen] = useOverlay();
  const searchInput = useRef<HTMLInputElement | null>(null);
  const value = useMemo<ShellUiState>(
    () => ({
      paletteOpen,
      setPaletteOpen,
      shortcutsOpen,
      setShortcutsOpen,
      navOpen,
      setNavOpen,
      registerSearchInput: (element) => {
        searchInput.current = element;
      },
      focusSearch: () => searchInput.current?.focus(),
    }),
    [paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, navOpen, setNavOpen],
  );
  return <ShellUiContext.Provider value={value}>{children}</ShellUiContext.Provider>;
}

export function useShellUi(): ShellUiState {
  const value = useContext(ShellUiContext);
  if (!value) throw new Error('useShellUi must be used inside <ShellUiProvider>');
  return value;
}
