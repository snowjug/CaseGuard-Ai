'use client';

import {
  FluentProvider,
  RendererProvider,
  SSRProvider,
  type GriffelRenderer,
  type SpinnerState,
} from '@fluentui/react-components';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { MotionProvider } from '../motion/MotionProvider';
import type { ThemeName } from '../tokens/palette';
import { getCaseGuardTheme, createSystemThemeCss } from '../tokens/themes';
import { useReducedMotionPreference, type ReducedMotionPreference } from './motion';
import { createCaseGuardRenderer } from './ssr';
import { resolveThemeMode, writeThemeCookie, type ThemeMode } from './theme-mode';

export interface ThemeModeContextValue {
  /** The stored preference (`system` follows the OS). */
  mode: ThemeMode;
  /** The theme actually rendered. */
  resolved: ThemeName;
  /** Persists the preference to the `cg-theme` cookie and applies it immediately. */
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/** Reads and changes the theme preference. Must be used under `CaseGuardThemeProvider`. */
export function useThemeMode(): ThemeModeContextValue {
  const value = useContext(ThemeModeContext);
  if (!value) throw new Error('useThemeMode must be used inside <CaseGuardThemeProvider>');
  return value;
}

export interface CaseGuardThemeProviderProps {
  /** Preference read from the `cg-theme` cookie on the server; defaults to `system`. */
  initialMode?: ThemeMode;
  /** Presentation mode enlarges type slightly (see `getCaseGuardTheme`). */
  presentation?: boolean;
  /**
   * Griffel renderer. Pass the same instance that the server style flusher reads
   * (`createStyleFlusher`) so styles rendered on the server are inlined into the HTML stream.
   */
  renderer?: GriffelRenderer;
  /** Applies the page canvas colour to the provider root (default true). */
  paintCanvas?: boolean;
  children: ReactNode;
}

const prefersDark = '(prefers-color-scheme: dark)';

const isSpinnerState = (state: unknown): state is SpinnerState =>
  typeof state === 'object' && state !== null && 'root' in state;

/**
 * A Spinner with no label and no name is a decorative "busy" icon (inside a pending button, beside a stage name). Left
 * as a `progressbar` it has no accessible name, which axe reports as serious (`aria-progressbar-name`), and any name it
 * was given would leak into the name of the button that holds it. So it is hidden from assistive technology; a Spinner
 * with a `label` (or its own `aria-label`) is left alone.
 */
function hideUnnamedSpinner(state: unknown): void {
  if (!isSpinnerState(state)) return;
  const root = state.root;
  if (state.label || root['aria-label'] || root['aria-labelledby']) return;
  root['aria-hidden'] = true;
}

const CUSTOM_STYLE_HOOKS: NonNullable<
  ComponentProps<typeof FluentProvider>['customStyleHooks_unstable']
> = { useSpinnerStyles_unstable: hideUnnamedSpinner };

function applyMotionAttribute(preference: ReducedMotionPreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-cg-reduced-motion');
  else root.setAttribute('data-cg-reduced-motion', preference === 'reduce' ? 'true' : 'false');
}

/**
 * SSR-safe theme provider: Griffel renderer + Fluent SSR context + FluentProvider with the CaseGuard theme.
 * `system` mode renders the light theme on the server together with a `prefers-color-scheme` override
 * (see `createSystemThemeCss`) and resolves the real preference after hydration, so there is no flash.
 */
export function CaseGuardThemeProvider({
  initialMode = 'system',
  presentation = false,
  renderer,
  paintCanvas = true,
  children,
}: CaseGuardThemeProviderProps) {
  const [ownRenderer] = useState(() => renderer ?? createCaseGuardRenderer());
  const activeRenderer = renderer ?? ownRenderer;
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const systemDark = useMediaQuery(prefersDark, false);
  const resolved = resolveThemeMode(mode, systemDark);
  const [motionPreference] = useReducedMotionPreference();

  const theme = useMemo(
    () => getCaseGuardTheme(resolved, { presentation }),
    [resolved, presentation],
  );
  // The dark overrides only matter while the preference is `system`; the CSS is pure ASCII-safe text (see theme tests).
  const systemCss = useMemo(
    () => (mode === 'system' ? createSystemThemeCss({ presentation }) : null),
    [mode, presentation],
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeThemeCookie(next);
    document.documentElement.dataset.cgTheme = next;
  }, []);

  useEffect(() => {
    applyMotionAttribute(motionPreference);
  }, [motionPreference]);

  const value = useMemo<ThemeModeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return (
    <RendererProvider renderer={activeRenderer}>
      <SSRProvider>
        <ThemeModeContext.Provider value={value}>
          <FluentProvider
            theme={theme}
            customStyleHooks_unstable={CUSTOM_STYLE_HOOKS}
            className={mode === 'system' ? 'cg-theme-system' : undefined}
            style={
              paintCanvas
                ? { backgroundColor: 'var(--cgCanvas)', color: 'var(--cgText)', minHeight: '100%' }
                : undefined
            }
          >
            {systemCss ? <style data-cg-system-theme="">{systemCss}</style> : null}
            <MotionProvider>{children}</MotionProvider>
          </FluentProvider>
        </ThemeModeContext.Provider>
      </SSRProvider>
    </RendererProvider>
  );
}
