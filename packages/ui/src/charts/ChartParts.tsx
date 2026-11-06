'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { cg } from '../tokens/cg';
import { markerPath } from './paths';

/** Font size used inside SVG charts (px). Captions are never smaller than 12 px. */
export const CHART_FONT_SIZE = 12;

/**
 * Observes an element's content width without setting state in an effect (`useSyncExternalStore`).
 * Falls back to `fallback` during SSR, before the first measurement and where ResizeObserver is missing (jsdom).
 */
export function useElementWidth<T extends HTMLElement>(
  fallback = 640,
): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!node || typeof ResizeObserver === 'undefined') return () => undefined;
      const observer = new ResizeObserver(onChange);
      observer.observe(node);
      return () => observer.disconnect();
    },
    [node],
  );
  const width = useSyncExternalStore(
    subscribe,
    () => (node && node.clientWidth > 0 ? node.clientWidth : fallback),
    () => fallback,
  );
  return [setNode, width];
}

export type SeriesMarker = 'circle' | 'square' | 'triangle' | 'diamond';
export const SERIES_MARKERS: readonly SeriesMarker[] = ['circle', 'square', 'triangle', 'diamond'];
/** Dash patterns so line series differ without colour: solid, dashed, dotted, dash-dot. */
export const SERIES_DASHES: readonly (string | undefined)[] = [
  undefined,
  '7 4',
  '1.5 4',
  '8 3 2 3',
];

export interface ChartTableProps {
  caption: string;
  headers: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}

/**
 * Visually hidden data table: the accessible equivalent of the chart. The table sits inside the hidden box instead of
 * being hidden itself: a `table` ignores a 1 px width and does not clip, so on its own it widened the whole page
 * (several thousand pixels of empty sideways scrolling).
 */
export function ChartTable({ caption, headers, rows }: ChartTableProps) {
  return (
    <VisuallyHidden as="div">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headers.map((header, i) => (
              <th key={`${header}-${i}`} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={cellIndex} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={cellIndex}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </VisuallyHidden>
  );
}

const useLegendStyles = makeStyles({
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  item: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
});

export interface LegendEntry {
  key: string;
  label: string;
  /** SVG swatch drawn at 28 x 12. */
  swatch: ReactNode;
  /** Optional trailing value, for example "42%". */
  value?: string;
}

/** Legend whose swatches repeat the series' dash, marker or pattern, so it works without colour. */
export function ChartLegend({
  entries,
  label = 'Legend',
}: {
  entries: readonly LegendEntry[];
  label?: string;
}) {
  const styles = useLegendStyles();
  if (entries.length === 0) return null;
  return (
    <ul className={styles.legend} aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.key} className={styles.item}>
          <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" focusable="false">
            {entry.swatch}
          </svg>
          <span>
            {entry.label}
            {entry.value ? (
              <strong style={{ marginLeft: cg.space[1], color: cg.text, fontWeight: 600 }}>
                {entry.value}
              </strong>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface ChartInspectorProps {
  /** Accessible name, for example "Inspect values: Hypothesis confidence over time". */
  label: string;
  /** Number of inspectable positions. */
  count: number;
  /** Current position or `null` when nothing is inspected. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
  /** Announced as the slider's value text for the current position. */
  valueText: string;
  height: number;
  /** Maps a pointer offset (relative to the chart frame) to the nearest position. */
  indexFromPointer: (x: number, y: number) => number;
  /**
   * Axis along which positions are laid out. `x` (default): Right/Up move forward. `y` (horizontal bars, top to
   * bottom): Down/Right move forward.
   */
  axis?: 'x' | 'y';
}

/**
 * Keyboard- and pointer-operable inspector laid over a chart. It is a labelled `slider` (arrows, Home, End,
 * Escape) whose value text is announced as the position changes, so data points are reachable without a mouse.
 */
export function ChartInspector({
  label,
  count,
  index,
  onIndexChange,
  valueText,
  height,
  indexFromPointer,
  axis = 'x',
}: ChartInspectorProps) {
  const styles = useChartStyles();
  if (count < 2) return null;
  const clamp = (n: number): number => Math.min(count - 1, Math.max(0, n));
  const forward = axis === 'x' ? ['ArrowRight', 'ArrowUp'] : ['ArrowRight', 'ArrowDown'];
  const backward = axis === 'x' ? ['ArrowLeft', 'ArrowDown'] : ['ArrowLeft', 'ArrowUp'];
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={index ?? 0}
      aria-valuetext={valueText || 'Use the arrow keys to inspect values'}
      className={styles.inspector}
      style={{ height }}
      onKeyDown={(event) => {
        const current = index ?? (backward.includes(event.key) || event.key === 'End' ? count : -1);
        if (forward.includes(event.key)) onIndexChange(clamp(current + 1));
        else if (backward.includes(event.key)) onIndexChange(clamp(current - 1));
        else if (event.key === 'Home') onIndexChange(0);
        else if (event.key === 'End') onIndexChange(count - 1);
        else if (event.key === 'Escape') {
          onIndexChange(null);
          return;
        } else return;
        event.preventDefault();
      }}
      onFocus={() => onIndexChange(index ?? count - 1)}
      onBlur={() => onIndexChange(null)}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onIndexChange(indexFromPointer(event.clientX - bounds.left, event.clientY - bounds.top));
      }}
      onPointerLeave={() => onIndexChange(null)}
    />
  );
}

/** Marker glyph for legends and data points. */
export function MarkerGlyph({
  shape,
  x,
  y,
  radius,
  color,
  halo,
}: {
  shape: SeriesMarker;
  x: number;
  y: number;
  radius: number;
  color: string;
  halo?: string;
}) {
  return (
    <path
      d={markerPath(shape, x, y, radius)}
      fill={color}
      stroke={halo ?? cg.surface}
      strokeWidth={1.25}
    />
  );
}

/** Shared figure styles. */
export const useChartStyles = makeStyles({
  figure: {
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    width: '100%',
  },
  caption: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  frame: { position: 'relative', width: '100%', minWidth: 0 },
  svg: { display: 'block', overflow: 'visible', maxWidth: '100%' },
  tooltip: {
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    padding: `${cg.space[1]} ${cg.space[2]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.borderControl}`,
    boxShadow: cg.shadowHigh,
    color: cg.text,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  tooltipTitle: { fontWeight: tokens.fontWeightSemibold, marginBottom: cg.space[1] },
  inspector: {
    position: 'absolute',
    inset: 0,
    borderRadius: cg.radius.sm,
    outlineStyle: 'none',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  empty: { fill: cg.textMuted, fontSize: `${CHART_FONT_SIZE}px` },
});
