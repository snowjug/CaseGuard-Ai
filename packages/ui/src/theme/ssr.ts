import { renderToStyleElements, type GriffelRenderer } from '@fluentui/react-components';
import { Fragment, createElement, type ReactElement } from 'react';

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
