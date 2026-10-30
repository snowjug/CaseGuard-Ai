import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { installMatchMedia } from './media';
import { installWebStorage } from './storage';

installWebStorage();

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-cg-reduced-motion');
  document.documentElement.removeAttribute('data-cg-theme');
  window.localStorage.clear();
  installMatchMedia();
});

installMatchMedia();

// jsdom lacks pointer capture and scrollIntoView, which the graph and palettes use. SVG elements are not
// HTMLElements, so the stubs live on Element.
Object.assign(Element.prototype, {
  setPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
  hasPointerCapture: vi.fn(() => false),
  scrollIntoView: vi.fn(),
});

// Tabster's modalizer marks a Fluent dialog `aria-hidden` until focus moves into it; with no layout engine in jsdom
// that activation is timing dependent (and fails on a slow machine). A browser ends up with the dialog exposed, so the
// attribute is removed here to keep role/name queries deterministic. Playwright covers the real focus behaviour.
new MutationObserver(() => {
  for (const surface of document.querySelectorAll('.fui-DialogSurface[aria-hidden="true"]'))
    surface.removeAttribute('aria-hidden');
}).observe(document.documentElement, {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ['aria-hidden'],
});
