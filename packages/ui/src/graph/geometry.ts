import type { GraphNode } from '@caseguard/schemas';
import { estimateTextWidth, truncateToWidth } from '../charts/scales';
import type { LayoutEdge, LayoutNode } from './layout';

/** Geometry helpers for node shapes and edge routes. Pure; shared by the view, legend and tests. */

export type NodeShape = 'circle' | 'hexagon' | 'square' | 'diamond' | 'stadium' | 'dna';
export type XY = readonly [number, number];

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Half extents and superellipse exponent used to find where a ray leaves a shape (edge endpoints, arrowheads). */
const BOUNDS: Record<NodeShape, { halfW: number; halfH: number; n: number }> = {
  circle: { halfW: 22, halfH: 22, n: 2 },
  hexagon: { halfW: 26, halfH: 22.5, n: 2.6 },
  square: { halfW: 20, halfH: 20, n: 4 },
  diamond: { halfW: 27, halfH: 27, n: 1 },
  stadium: { halfW: 30, halfH: 17, n: 3 },
  dna: { halfW: 21.7, halfH: 25, n: 2.6 },
};

/** Distance from a shape's centre to its boundary along the unit direction (ux, uy). */
export function boundaryDistance(shape: NodeShape, ux: number, uy: number): number {
  const { halfW, halfH, n } = BOUNDS[shape];
  const sum = Math.abs(ux / halfW) ** n + Math.abs(uy / halfH) ** n;
  return sum === 0 ? Math.max(halfW, halfH) : 1 / sum ** (1 / n);
}

/** Largest half-extent of a shape: the clearance edges keep from shape centres when arcing over nodes. */
export function shapeClearance(shape: NodeShape): number {
  const { halfW, halfH } = BOUNDS[shape];
  return Math.max(halfW, halfH);
}

/** Closed polygon with rounded corners (quadratic corners), used for hexagons and diamonds. */
export function roundedPolygonPath(points: readonly XY[], radius: number): string {
  const count = points.length;
  if (count < 3) return '';
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const prev = points[(i + count - 1) % count] as XY;
    const current = points[i] as XY;
    const next = points[(i + 1) % count] as XY;
    const toPrev = Math.hypot(prev[0] - current[0], prev[1] - current[1]);
    const toNext = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const cut = Math.min(radius, toPrev / 2, toNext / 2);
    const a: XY = [
      current[0] + ((prev[0] - current[0]) / toPrev) * cut,
      current[1] + ((prev[1] - current[1]) / toPrev) * cut,
    ];
    const b: XY = [
      current[0] + ((next[0] - current[0]) / toNext) * cut,
      current[1] + ((next[1] - current[1]) / toNext) * cut,
    ];
    parts.push(
      `${i === 0 ? 'M' : 'L'}${r2(a[0])} ${r2(a[1])}Q${r2(current[0])} ${r2(current[1])} ${r2(b[0])} ${r2(b[1])}`,
    );
  }
  return `${parts.join('')}Z`;
}

/** Outline path for a node shape centred on (cx, cy). `scale` shrinks it for the inner ring of the DNA node. */
export function shapePath(shape: NodeShape, cx: number, cy: number, scale = 1): string {
  switch (shape) {
    case 'circle': {
      const r = 22 * scale;
      return `M${r2(cx - r)} ${r2(cy)}a${r2(r)} ${r2(r)} 0 1 0 ${r2(r * 2)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-r * 2)} 0Z`;
    }
    case 'hexagon': {
      const rx = 26 * scale;
      const ry = 22.5 * scale;
      return roundedPolygonPath(
        [
          [cx - rx, cy],
          [cx - rx / 2, cy - ry],
          [cx + rx / 2, cy - ry],
          [cx + rx, cy],
          [cx + rx / 2, cy + ry],
          [cx - rx / 2, cy + ry],
        ],
        6,
      );
    }
    case 'square': {
      const h = 20 * scale;
      const rad = 9 * scale;
      return `M${r2(cx - h + rad)} ${r2(cy - h)}H${r2(cx + h - rad)}Q${r2(cx + h)} ${r2(cy - h)} ${r2(cx + h)} ${r2(cy - h + rad)}V${r2(cy + h - rad)}Q${r2(cx + h)} ${r2(cy + h)} ${r2(cx + h - rad)} ${r2(cy + h)}H${r2(cx - h + rad)}Q${r2(cx - h)} ${r2(cy + h)} ${r2(cx - h)} ${r2(cy + h - rad)}V${r2(cy - h + rad)}Q${r2(cx - h)} ${r2(cy - h)} ${r2(cx - h + rad)} ${r2(cy - h)}Z`;
    }
    case 'diamond': {
      const d = 27 * scale;
      return roundedPolygonPath(
        [
          [cx, cy - d],
          [cx + d, cy],
          [cx, cy + d],
          [cx - d, cy],
        ],
        5,
      );
    }
    case 'stadium': {
      const w = 30 * scale;
      const h = 17 * scale;
      return `M${r2(cx - w + h)} ${r2(cy - h)}H${r2(cx + w - h)}A${r2(h)} ${r2(h)} 0 0 1 ${r2(cx + w - h)} ${r2(cy + h)}H${r2(cx - w + h)}A${r2(h)} ${r2(h)} 0 0 1 ${r2(cx - w + h)} ${r2(cy - h)}Z`;
    }
    default: {
      const rx = 21.65 * scale;
      const ry = 25 * scale;
      return roundedPolygonPath(
        [
          [cx, cy - ry],
          [cx + rx, cy - ry / 2],
          [cx + rx, cy + ry / 2],
          [cx, cy + ry],
          [cx - rx, cy + ry / 2],
          [cx - rx, cy - ry / 2],
        ],
        5,
      );
    }
  }
}

export interface EdgeRoute {
  /** SVG path data. */
  d: string;
  /** Midpoint, useful for hit targets. */
  mid: XY;
}

const SAG = 40;

/**
 * Route for one edge. Adjacent same-lane nodes get a straight segment; skipping nodes in a lane arcs over them;
 * edges between lanes get an S-curve. Endpoints sit on the shape boundaries so arrowheads touch the target.
 */
export function routeEdge(
  from: LayoutNode,
  to: LayoutNode,
  shapeOf: (node: GraphNode) => NodeShape,
  gap = 3,
): EdgeRoute {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const start: XY = [
    from.cx + ux * (boundaryDistance(shapeOf(from.node), ux, uy) + gap),
    from.cy + uy * (boundaryDistance(shapeOf(from.node), ux, uy) + gap),
  ];
  const end: XY = [
    to.cx - ux * (boundaryDistance(shapeOf(to.node), -ux, -uy) + gap + 5),
    to.cy - uy * (boundaryDistance(shapeOf(to.node), -ux, -uy) + gap + 5),
  ];
  const sx = start[0];
  const sy = start[1];
  const ex = end[0];
  const ey = end[1];
  const sameLane = from.laneIndex === to.laneIndex;
  const columnSpan = Math.abs(to.column - from.column);

  if (sameLane && columnSpan <= 1) {
    return { d: `M${r2(sx)} ${r2(sy)}L${r2(ex)} ${r2(ey)}`, mid: [(sx + ex) / 2, (sy + ey) / 2] };
  }
  if (sameLane) {
    const lift = SAG + (shapeOf(from.node) === 'diamond' ? 6 : 0);
    const direction = ex >= sx ? 1 : -1;
    const c1: XY = [sx + direction * 24, sy - lift * 1.25];
    const c2: XY = [ex - direction * 24, ey - lift * 1.25];
    return {
      d: `M${r2(sx)} ${r2(sy)}C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(ex)} ${r2(ey)}`,
      mid: [(sx + ex) / 2, sy - lift * 0.94],
    };
  }
  const vertical = Math.abs(ey - sy) >= Math.abs(ex - sx);
  const c1: XY = vertical ? [sx, sy + (ey - sy) * 0.5] : [sx + (ex - sx) * 0.5, sy];
  const c2: XY = vertical ? [ex, ey - (ey - sy) * 0.5] : [ex - (ex - sx) * 0.5, ey];
  return {
    d: `M${r2(sx)} ${r2(sy)}C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(ex)} ${r2(ey)}`,
    mid: [(sx + ex) / 2, (sy + ey) / 2],
  };
}

/** Word-wraps `text` into at most `maxLines` lines that fit `maxWidth` (estimated); the last line ends with an ellipsis when text is cut. */
export function wrapLabel(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    // The joined remainder is wider than one line, so truncation adds the ellipsis.
    head.push(truncateToWidth(lines.slice(maxLines - 1).join(' '), maxWidth, fontSize));
    return head;
  }
  return lines.map((l) => truncateToWidth(l, maxWidth, fontSize));
}

/** Edges incident to a node. */
export function incidentEdges(edges: readonly LayoutEdge[], nodeId: string): LayoutEdge[] {
  return edges.filter((e) => e.from === nodeId || e.to === nodeId);
}
