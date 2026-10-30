'use client';

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useOverlayState as useOverlay } from './use-overlay-state';

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
