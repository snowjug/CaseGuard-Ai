import {
  createDOMRenderer,
  renderToStyleElements,
  type GriffelRenderer,
} from '@fluentui/react-components';
import { Fragment, createElement, type ReactElement } from 'react';

const WIDTH_QUERY = /\((min|max)-width:\s*(\d+(?:\.\d+)?)px\)/;

/**
 * Orders media queries for Griffel the way a mobile-first stylesheet needs: `min-width` rules from small to large, then
 * `max-width` rules from large to small, so the narrowest or widest matching rule is the one declared last and wins.
 * Griffel's default compares the query text, which puts `(min-width: 1024px)` before `(min-width: 640px)`, so a
 * 640 px rule then overrides a 1024 px one on a desktop.
 */
export function compareMediaQueries(a: string, b: string): number {
  if (a === b) return 0;
  const left = WIDTH_QUERY.exec(a);
  const right = WIDTH_QUERY.exec(b);
  if (left && right) {
    if (left[1] === right[1]) {
      const delta = Number(left[2]) - Number(right[2]);
      return left[1] === 'min' ? delta : -delta;
    }
    return left[1] === 'min' ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

/** The Griffel renderer of the app: the default one, with media queries in mobile-first order (see `compareMediaQueries`). */
export function createCaseGuardRenderer(): GriffelRenderer {
  return createDOMRenderer(undefined, { compareMediaQueries });
}

/**
 * Creates the callback for Next's `useServerInsertedHTML`. Each call returns the style elements for the rules
 * rendered so far, or `null` when nothing new was rendered since the previous flush (streaming can flush many times).
 *
 * ```tsx
 * 'use client';
 * const [renderer] = useState(() => createDOMRenderer());
 * const flush = useMemo(() => createStyleFlusher(renderer), [renderer]);
 * useServerInsertedHTML(flush);
 * ```
 *
 * The style sheets are emitted in full on every flush that has new rules: duplicates are harmless in CSS and the
 * Griffel bucket ordering stays correct, which an incremental diff could not guarantee.
 */
export function createStyleFlusher(renderer: GriffelRenderer): () => ReactElement | null {
  let flushedRules = 0;
  return () => {
    const rules = Object.keys(renderer.insertionCache).length;
    if (rules === flushedRules) return null;
    flushedRules = rules;
    return createElement(Fragment, null, ...renderToStyleElements(renderer));
  };
}
