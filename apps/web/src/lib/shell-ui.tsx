'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useOverlayState as useOverlay } from './use-overlay-state';

export interface ShellUiState {
  /** The command palette, which is also where search lives. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  /** Opens the palette with the cursor in its field (the `/` shortcut and the search button). */
  openSearch: () => void;
}

const ShellUiContext = createContext<ShellUiState | null>(null);

/** Open/close state for the shell's overlays (command palette and search, shortcut help). */
export function ShellUiProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useOverlay();
  const [shortcutsOpen, setShortcutsOpen] = useOverlay();
  const value = useMemo<ShellUiState>(
    () => ({
      paletteOpen,
      setPaletteOpen,
      shortcutsOpen,
      setShortcutsOpen,
      openSearch: () => setPaletteOpen(true),
    }),
    [paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen],
  );
  return <ShellUiContext.Provider value={value}>{children}</ShellUiContext.Provider>;
}

export function useShellUi(): ShellUiState {
  const value = useContext(ShellUiContext);
  if (!value) throw new Error('useShellUi must be used inside <ShellUiProvider>');
  return value;
}
