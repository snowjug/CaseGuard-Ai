import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { installMatchMedia } from '../../test/media';
import { renderWithTheme, expectNoAxeViolations } from '../../test/axe';
import { compareMediaQueries, createStyleFlusher } from './ssr';
import {
  createReducedMotionStore,
  parseReducedMotionPreference,
  useReducedMotion,
  reducedMotionStore,
} from './motion';
import { createPersistedStore } from './persisted-store';
import {
  THEME_COOKIE,
  parseThemeMode,
  readThemeCookie,
  resolveThemeMode,
  serializeThemeCookie,
  writeThemeCookie,
} from './theme-mode';
import { useThemeMode } from './ThemeProvider';
import { Button, Spinner, createDOMRenderer } from '@fluentui/react-components';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('[FR-UX-03] theme cookie helpers', () => {
  it('reads the preference from a Cookie header and ignores junk', () => {
    expect(readThemeCookie('a=1; cg-theme=dark; b=2')).toBe('dark');
    expect(readThemeCookie('cg-theme=light')).toBe('light');
    expect(readThemeCookie('cg-theme=purple')).toBe('system');
    expect(readThemeCookie('other=dark')).toBe('system');
    expect(readThemeCookie(undefined)).toBe('system');
    expect(readThemeCookie(null, 'light')).toBe('light');
  });

  it('serialises a one-year first-party Lax cookie', () => {
    const cookie = serializeThemeCookie('dark');
    expect(cookie).toContain(`${THEME_COOKIE}=dark`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(serializeThemeCookie('light', { secure: true })).toContain('Secure');
  });

  it('writes the cookie to the document and resolves system mode', () => {
    const doc = { cookie: '' };
    writeThemeCookie('dark', doc);
    expect(doc.cookie).toMatch(/^cg-theme=dark;/);
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(parseThemeMode('nope')).toBe('system');
  });
});

describe('persisted stores and reduced motion preference', () => {
  it('persists values, notifies subscribers and survives unavailable storage', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage;
    const store = createReducedMotionStore(() => fake);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.get()).toBe('system');
    store.set('reduce');
    expect(store.get()).toBe('reduce');
    expect(storage.get('cg-reduced-motion')).toBe('reduce');
    expect(listener).toHaveBeenCalledTimes(1);
    store.set('system');
    expect(storage.has('cg-reduced-motion')).toBe(false);
    unsubscribe();
    store.set('allow');
    expect(listener).toHaveBeenCalledTimes(2);

    const broken = createPersistedStore<string>({
      key: 'k',
      parse: (raw) => raw ?? 'default',
      serialize: (v) => v,
      getStorage: () => {
        throw new Error('blocked');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    broken.set('x');
    expect(broken.get()).toBe('x');
    warn.mockRestore();
  });

  it('parses only known preferences', () => {
    expect(parseReducedMotionPreference('reduce')).toBe('reduce');
    expect(parseReducedMotionPreference('allow')).toBe('allow');
    expect(parseReducedMotionPreference('anything')).toBe('system');
    expect(parseReducedMotionPreference(null)).toBe('system');
  });

  it('useReducedMotion follows the OS unless the user overrides it', () => {
    installMatchMedia((q) => q === '(prefers-reduced-motion: reduce)');
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
    act(() => reducedMotionStore.set('allow'));
    expect(result.current).toBe(false);
    act(() => reducedMotionStore.set('reduce'));
    expect(result.current).toBe(true);
    installMatchMedia();
    act(() => reducedMotionStore.set('system'));
    expect(result.current).toBe(false);
  });
});

function ModeProbe() {
  const { mode, resolved, setMode } = useThemeMode();
  return (
    <div>
      <p data-testid="state">{`${mode}:${resolved}`}</p>
      <button type="button" onClick={() => setMode('dark')}>
        Dark
      </button>
      <button type="button" onClick={() => setMode('system')}>
        System
      </button>
    </div>
  );
}

describe('CaseGuardThemeProvider', () => {
  it('renders the server-provided mode, persists changes to the cookie and the html attribute', async () => {
    const user = userEvent.setup();
    document.cookie = 'cg-theme=; Max-Age=0; Path=/';
    renderWithTheme(<ModeProbe />, 'light');
    expect(screen.getByTestId('state')).toHaveTextContent('light:light');
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByTestId('state')).toHaveTextContent('dark:dark');
    expect(document.cookie).toContain('cg-theme=dark');
    expect(document.documentElement.dataset.cgTheme).toBe('dark');
  });

  it('resolves system mode from prefers-color-scheme and tags the root for the SSR media-query override', async () => {
    installMatchMedia((q) => q === '(prefers-color-scheme: dark)');
    const user = userEvent.setup();
    const { container } = renderWithTheme(<ModeProbe />, 'system');
    expect(screen.getByTestId('state')).toHaveTextContent('system:dark');
    expect(container.querySelector('.cg-theme-system')).not.toBeNull();
    expect(container.querySelector('style[data-cg-system-theme]')?.textContent).toContain(
      'prefers-color-scheme: dark',
    );
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('.cg-theme-system')).toBeNull();
    expect(container.querySelector('style[data-cg-system-theme]')).toBeNull();
  });

  it('refuses to be used without a provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useThemeMode())).toThrow(/CaseGuardThemeProvider/);
    error.mockRestore();
  });

  it('applies the manual reduced-motion override to the html element', async () => {
    window.localStorage.setItem('cg-reduced-motion', 'reduce');
    renderWithTheme(<p>content</p>);
    expect(document.documentElement.getAttribute('data-cg-reduced-motion')).toBe('true');
  });
});

describe('unnamed spinners', () => {
  it('hides a decorative busy icon, so it has no nameless progressbar and does not rename its button', async () => {
    const { container } = renderWithTheme(
      <Button disabled icon={<Spinner size="tiny" />}>
        Save
      </Button>,
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(container.querySelector('.fui-Spinner')).toHaveAttribute('aria-hidden', 'true');
    await expectNoAxeViolations(container);
  });

  it('leaves a spinner with a label or a name exposed', async () => {
    const { container } = renderWithTheme(
      <div>
        <Spinner label="Loading cases" />
        <Spinner aria-label="Saving" size="tiny" />
      </div>,
    );
    expect(screen.getByRole('progressbar', { name: 'Loading cases' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Saving' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('media query order', () => {
  it('sorts min-width rules small to large, then max-width rules large to small, so the narrowest match wins', () => {
    const queries = [
      '(max-width: 767px)',
      '(min-width: 1024px)',
      '(max-width: 1023px)',
      '(min-width: 640px)',
    ];
    expect([...queries].sort(compareMediaQueries)).toEqual([
      '(min-width: 640px)',
      '(min-width: 1024px)',
      '(max-width: 1023px)',
      '(max-width: 767px)',
    ]);
  });
});

describe('server style flush', () => {
  it('returns style elements once per batch of new rules', () => {
    const renderer = createDOMRenderer();
    const flush = createStyleFlusher(renderer);
    expect(flush()).toBeNull();
    // On a real server Griffel inserts during render; under jsdom it defers to an effect, so insert directly.
    renderer.insertCSSRules({ d: ['.fcg1{color:red;}'] });
    const first = flush();
    expect(first).not.toBeNull();
    expect(renderToStaticMarkup(first as ReactElement)).toContain('<style');
    expect(renderToStaticMarkup(first as ReactElement)).toMatch(/\.fcg1\s*\{\s*color:\s*red/);
    expect(flush()).toBeNull();
    renderer.insertCSSRules({ d: ['.fcg2{color:blue;}'] });
    expect(renderToStaticMarkup(flush() as ReactElement)).toContain('.fcg2');
  });
});
