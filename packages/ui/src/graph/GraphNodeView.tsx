'use client';

import { makeStyles } from '@fluentui/react-components';
import { useState, type KeyboardEvent } from 'react';
import { estimateTextWidth, truncateToWidth } from '../charts/scales';
import { formatProbability } from '../format';
import { patternUrl } from '../primitives/SvgPatternDefs';
import { STATUS_META } from '../primitives/status-meta';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { shapePath, wrapLabel } from './geometry';
import { SHAPE_CENTER_Y, type LayoutNode } from './layout';
import { KIND_META, nodeAriaLabel } from './node-meta';

const LABEL_SIZE = 12;
const LINE_HEIGHT = 15;

const useStyles = makeStyles({
  node: { cursor: 'pointer', outlineStyle: 'none' },
  label: { pointerEvents: 'none', userSelect: 'none' },
});

/** `:focus-visible` check that tolerates engines (jsdom) which cannot evaluate the selector. */
function showsFocusRing(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export interface GraphNodeViewProps {
  item: LayoutNode;
  /** Prefix of the SVG pattern ids defined by the parent graph. */
  idPrefix: string;
  selected: boolean;
  /** Roving tabindex: only one node is in the tab order. */
  tabbable: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, id: string) => void;
  onFocus: (id: string) => void;
  registerNode: (id: string, element: SVGGElement | null) => void;
}

/** Resolves how a node is painted: simulated beats unsupported beats uncertain beats missing beats the kind default. */
export function resolvePaint(item: Pick<LayoutNode, 'node'>): {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: string | undefined;
  icon: string;
  pattern: 'hatch' | 'crosshatch' | 'dots' | null;
  patternTone: ToneName;
  outlineOnly: boolean;
} {
  const { node } = item;
  const kind = KIND_META[node.kind];
  const simulated = node.simulated || node.kind === 'counterfactual_step';
  const base = { dash: undefined, patternTone: 'neutral' as ToneName };
  if (simulated) {
    const t = cg.tone.simulated;
    return {
      ...base,
      fill: t.tint,
      stroke: t.solid,
      strokeWidth: 2,
      dash: '5 3',
      icon: t.fg,
      pattern: 'hatch',
      patternTone: 'simulated',
      outlineOnly: false,
    };
  }
  if (node.status === 'unsupported') {
    const t = cg.tone.unsupported;
    return {
      ...base,
      fill: t.tint,
      stroke: t.solid,
      strokeWidth: 2,
      icon: t.fg,
      pattern: 'crosshatch',
      patternTone: 'unsupported',
      outlineOnly: false,
    };
  }
  if (node.status === 'uncertain') {
    const t = cg.tone.uncertain;
    return {
      ...base,
      fill: t.tint,
      stroke: t.solid,
      strokeWidth: 2,
      icon: t.fg,
      pattern: 'dots',
      patternTone: 'uncertain',
      outlineOnly: false,
    };
  }
  if (node.status === 'missing') {
    const t = cg.tone.missing;
    return {
      ...base,
      fill: 'none',
      stroke: t.solid,
      strokeWidth: 2,
      icon: t.fg,
      pattern: null,
      outlineOnly: true,
    };
  }
  const t = cg.tone[kind.tone];
  if (kind.fill === 'solid') {
    return {
      ...base,
      fill: t.solid,
      stroke: t.solid,
      strokeWidth: 2,
      icon: t.onSolid,
      pattern: null,
      outlineOnly: false,
    };
  }
  return {
    ...base,
    fill: t.tint,
    stroke: t.solid,
    strokeWidth: 2.25,
    icon: t.fg,
    pattern: null,
    outlineOnly: false,
  };
}

/** Status glyph badge at a corner of the shape. */
function Glyph({
  x,
  y,
  icon: Icon,
  tone,
}: {
  x: number;
  y: number;
  icon: (typeof STATUS_META)[keyof typeof STATUS_META]['icon'];
  tone: (typeof cg.tone)[keyof typeof cg.tone];
}) {
  return (
    <g aria-hidden="true">
      <circle cx={x} cy={y} r={9.5} fill={cg.surface} stroke={tone.solid} strokeWidth={1.5} />
      <Icon x={x - 6.5} y={y - 6.5} width={13} height={13} fill={tone.fg} />
    </g>
  );
}

/**
 * One investigation-graph node: shape by kind, texture by status, dashed hatch when simulated, a glyph badge for the
 * status, a truncated label inside its own cell and a roving-tabindex button for keyboard users.
 */
export function GraphNodeView({
  item,
  idPrefix,
  selected,
  tabbable,
  dimmed,
  onSelect,
  onKeyDown,
  onFocus,
  registerNode,
}: GraphNodeViewProps) {
  const styles = useStyles();
  const [ring, setRing] = useState(false);
  const { node } = item;
  const kind = KIND_META[node.kind];
  const status = STATUS_META[node.status];
  const simulated = node.simulated || node.kind === 'counterfactual_step';
  const paint = resolvePaint(item);
  const KindIcon = kind.icon;
  const cx = item.width / 2;
  const cy = SHAPE_CENTER_Y;
  const maxLabelWidth = item.labelBox.width;
  const lines = wrapLabel(node.label, maxLabelWidth, LABEL_SIZE, 2);
  const captionParts: string[] = [];
  if (simulated) captionParts.push('Simulated');
  if (node.confidence !== null) captionParts.push(`${formatProbability(node.confidence)} est.`);
  const caption = truncateToWidth(captionParts.join(' · '), maxLabelWidth, LABEL_SIZE);
  const labelTop = item.labelBox.y - item.y;
  const showStatusGlyph = node.status !== 'neutral';
  const outerScale = 1.2;

  return (
    <g transform={`translate(${item.x} ${item.y})`} opacity={dimmed ? 0.4 : 1}>
      <g
        ref={(element) => registerNode(item.id, element)}
        role="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={nodeAriaLabel(node)}
        aria-pressed={selected}
        data-node-id={item.id}
        data-kind={node.kind}
        data-status={node.status}
        data-simulated={simulated ? 'true' : 'false'}
        className={styles.node}
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => onKeyDown(event, item.id)}
        onFocus={(event) => {
          setRing(showsFocusRing(event.currentTarget));
          onFocus(item.id);
        }}
        onBlur={() => setRing(false)}
      >
        <title>{`${kind.label}: ${node.label}`}</title>
        {/* Transparent hit area: the whole cell, label included, selects the node. */}
        <rect width={item.width} height={item.height} fill="transparent" />
        {ring ? (
          <g aria-hidden="true">
            <path
              d={shapePath(kind.shape, cx, cy, 1.34)}
              fill="none"
              stroke={cg.surface}
              strokeWidth={6}
            />
            <path
              d={shapePath(kind.shape, cx, cy, 1.34)}
              fill="none"
              stroke={cg.focus}
              strokeWidth={3}
            />
          </g>
        ) : null}
        {selected ? (
          <path
            d={shapePath(kind.shape, cx, cy, outerScale)}
            fill="none"
            stroke={cg.text}
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : null}
        <path
          d={shapePath(kind.shape, cx, cy)}
          fill={
            paint.pattern
              ? patternUrl(idPrefix, paint.pattern, paint.patternTone)
              : paint.outlineOnly
                ? cg.surface
                : paint.fill
          }
          stroke={paint.stroke}
          strokeWidth={selected ? paint.strokeWidth + 1.25 : paint.strokeWidth}
          strokeDasharray={paint.dash}
          strokeLinejoin="round"
        />
        {kind.shape === 'dna' ? (
          <path
            d={shapePath('dna', cx, cy, 0.68)}
            fill="none"
            stroke={paint.stroke}
            strokeWidth={1.25}
            strokeOpacity={0.85}
            aria-hidden="true"
          />
        ) : null}
        {node.status === 'productive' && !simulated ? (
          <path
            d={shapePath(kind.shape, cx, cy, 1.1)}
            fill="none"
            stroke={cg.tone.productive.solid}
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : null}
        <KindIcon
          x={cx - 11}
          y={cy - 11}
          width={22}
          height={22}
          fill={paint.icon}
          aria-hidden="true"
        />
        {simulated ? (
          <Glyph
            x={cx - 21}
            y={cy - 22}
            icon={KIND_META.counterfactual_step.icon}
            tone={cg.tone.simulated}
          />
        ) : null}
        {showStatusGlyph ? (
          <Glyph x={cx + 21} y={cy - 22} icon={status.icon} tone={cg.tone[status.tone]} />
        ) : null}
      </g>
      {/*
        The visible label is a sibling of the button, not its content: the button's accessible name is the full
        description above, and the (possibly truncated) label is a sighted-user aid that assistive technology skips.
      */}
      <text
        className={styles.label}
        textAnchor="middle"
        fontSize={LABEL_SIZE}
        fill={cg.text}
        stroke={cg.surface}
        strokeWidth={4}
        strokeLinejoin="round"
        paintOrder="stroke"
        aria-hidden="true"
      >
        {lines.map((line, index) => (
          <tspan key={index} x={cx} y={labelTop + 11 + index * LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
        {caption ? (
          <tspan
            x={cx}
            y={labelTop + 11 + lines.length * LINE_HEIGHT}
            fill={simulated ? cg.tone.simulated.fg : cg.textSecondary}
            fontWeight={600}
          >
            {caption}
          </tspan>
        ) : null}
      </text>
    </g>
  );
}

/** Re-exported for tests that assert truncation never exceeds the label box. */
export const labelMetrics = { LABEL_SIZE, LINE_HEIGHT, estimateTextWidth };
