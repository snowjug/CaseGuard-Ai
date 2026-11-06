import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useActiveCase } from '../lib/active-case';
import { useThemeMode } from '@caseguard/ui';
import RootLayout, { metadata, viewport } from './layout';
import { Providers } from './providers';

let jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  }),
}));

async function renderLayout(
  cookies: Record<string, string>,
): Promise<ReactElement<{ lang: string; 'data-cg-theme': string; children: ReactNode }>> {
  jar = cookies;
  const element = await RootLayout({ children: <p>content</p> });
  if (!isValidElement(element)) throw new Error('RootLayout did not return an element');
  return element as ReactElement<{ lang: string; 'data-cg-theme': string; children: ReactNode }>;
}

function providersProps(layout: ReactElement<{ children: ReactNode }>): {
  initialThemeMode: string;
  initialCaseId: string | null;
  initialPersonaId: string | null;
} {
  const body = layout.props.children as ReactElement<{
    children: ReactElement<{
      initialThemeMode: string;
      initialCaseId: string | null;
      initialPersonaId: string | null;
    }>;
  }>;
  return body.props.children.props;
}

describe('[UX-THEME-01] root layout reads the cg-theme cookie on the server', () => {
  it('renders the stored mode on <html> so the first paint has the right theme', async () => {
    for (const mode of ['light', 'dark', 'system']) {
      const layout = await renderLayout({ 'cg-theme': mode });
      expect(layout.props['data-cg-theme']).toBe(mode);
      expect(providersProps(layout).initialThemeMode).toBe(mode);
    }
    expect((await renderLayout({})).props['data-cg-theme']).toBe('system');
  });

  it('falls back to system for an invalid cookie value and sets the document language', async () => {
    const layout = await renderLayout({ 'cg-theme': '<script>' });
    expect(layout.props['data-cg-theme']).toBe('system');
    expect(layout.props.lang).toBe('en');
  });

  it('passes only a well-formed remembered case id to the client', async () => {
    expect(providersProps(await renderLayout({ 'cg-case': 'case_42' })).initialCaseId).toBe(
      'case_42',
    );
    expect(
      providersProps(await renderLayout({ 'cg-case': '../etc/passwd' })).initialCaseId,
    ).toBeNull();
    expect(providersProps(await renderLayout({})).initialCaseId).toBeNull();
  });

  it('passes only a well-formed remembered persona to the client, so a returning person gets a skeleton and not the first-visit page', async () => {
    expect(
      providersProps(await renderLayout({ 'cg-persona': 'user_ava_engineer' })).initialPersonaId,
    ).toBe('user_ava_engineer');
    expect(
      providersProps(await renderLayout({ 'cg-persona': 'user%3Aava' })).initialPersonaId,
    ).toBe('user:ava');
    expect(
      providersProps(await renderLayout({ 'cg-persona': '../../admin' })).initialPersonaId,
    ).toBeNull();
    expect(
      providersProps(await renderLayout({ 'cg-persona': '%E0%A4%A' })).initialPersonaId,
    ).toBeNull();
    expect(providersProps(await renderLayout({})).initialPersonaId).toBeNull();
  });

  it('declares light and dark theme colours and keeps the app out of search engines', () => {
    expect(Array.isArray(viewport.themeColor)).toBe(true);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

function Probe() {
  const { mode, resolved } = useThemeMode();
  const { caseId } = useActiveCase();
  return (
    <p>
      mode:{mode} resolved:{resolved} case:{caseId ?? 'none'}
    </p>
  );
}

describe('[UX-THEME-02] provider tree', () => {
  it('wires the theme, identity, API client, toasts, shortcuts and active case together', () => {
    // The layout reads the cg-case cookie on the server; on the client the same cookie is the source of truth.
    document.cookie = 'cg-case=case_1; Path=/';
    render(
      <Providers initialThemeMode="dark" initialCaseId="case_1">
        <Probe />
      </Providers>,
    );
    expect(screen.getByText('mode:dark resolved:dark case:case_1')).toBeInTheDocument();
  });
});
