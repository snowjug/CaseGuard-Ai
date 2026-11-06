import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { installMatchMedia } from './media';
import { navigateTo, patchHistory, router, setNavigationLatency } from './next-navigation';
import { installWebStorage } from './storage';

// `next/navigation` needs the App Router at runtime; tests use a history-backed fake (see test/next-navigation.ts).
vi.mock('next/navigation', () => import('./next-navigation'));

installWebStorage();
patchHistory();
installMatchMedia();

// jsdom lacks pointer capture and scrollIntoView, which the graph, palette and listboxes use.
Object.assign(Element.prototype, {
  setPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
  hasPointerCapture: vi.fn(() => false),
  scrollIntoView: vi.fn(),
});

// jsdom has no ResizeObserver, and cmdk (the command palette) observes its list with one. No layout ever happens in
// jsdom, so an observer that never fires is faithful; tests that need a firing one stub it themselves.
if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
}

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

// Tabster's modalizer marks a Fluent dialog `aria-hidden` until focus moves into it, and in jsdom (no layout, so no
// "first focusable") that never happens. A real browser activates it; Playwright covers that. Removing the attribute
// here lets role/name queries and axe see the dialog the way a browser's accessibility tree does. The name of an
// `aria-hidden` element computes to the empty string even for a query with `hidden: true`, so a query by name only
// found an overlay drawer (class `fui-OverlayDrawer`, not `fui-DialogSurface`) in the moment before Tabster hid it:
// whether it won that race depended on timing, and it lost it now and then on a busy machine.
new MutationObserver(() => {
  for (const surface of document.querySelectorAll(
    '.fui-DialogSurface[aria-hidden="true"], .fui-OverlayDrawer[aria-hidden="true"]',
  ))
    surface.removeAttribute('aria-hidden');
}).observe(document.documentElement, {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ['aria-hidden'],
});

afterEach(() => {
  cleanup();
  setNavigationLatency(0);
  navigateTo('/');
  clearCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const attribute of ['data-cg-reduced-motion', 'data-cg-theme', 'data-cg-present'])
    document.documentElement.removeAttribute(attribute);
  installMatchMedia();
  for (const fn of Object.values(router)) fn.mockClear();
});
