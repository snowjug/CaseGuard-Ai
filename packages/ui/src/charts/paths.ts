/** Pure SVG path builders. Coordinates are rounded to two decimals to keep the DOM small and diffs stable. */

export type Point = readonly [number, number];

const r = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Polyline path through `points`. `null` entries break the line into separate segments (data gaps).
 * Returns an empty string when there is nothing to draw; a single point yields a zero-length move.
 */
export function linePath(points: readonly (Point | null)[]): string {
  let path = '';
  let pen = false;
  for (const point of points) {
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : path ? ' M' : 'M'}${r(point[0])} ${r(point[1])}`;
    pen = true;
  }
  return path;
}

/**
 * Closed polygon between an upper and a lower edge (confidence bands): the upper edge left to right,
 * then the lower edge right to left. Both edges must have the same x positions and length.
 */
export function bandPath(upper: readonly Point[], lower: readonly Point[]): string {
  if (upper.length === 0 || upper.length !== lower.length) return '';
  const forward = upper.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(p[0])} ${r(p[1])}`);
  const backward = [...lower].reverse().map((p) => `L${r(p[0])} ${r(p[1])}`);
  return `${forward.join('')}${backward.join('')}Z`;
}

/** Point on a circle at `angleDeg` (0 = 12 o'clock, clockwise). */
export function polar(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

/**
 * Circular arc from `startDeg` to `endDeg` (clockwise, 0 = 12 o'clock). A sweep of 360 degrees or more is drawn as
 * two half arcs, because a single SVG arc cannot start and end at the same point.
 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = Math.min(359.999, Math.max(0, endDeg - startDeg));
  if (sweep <= 0) return '';
  const start = polar(cx, cy, radius, startDeg);
  const end = polar(cx, cy, radius, startDeg + sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M${r(start[0])} ${r(start[1])}A${r(radius)} ${r(radius)} 0 ${largeArc} 1 ${r(end[0])} ${r(end[1])}`;
}

/** Marker shape outlines centred on (x, y) with the given radius. */
export function markerPath(
  shape: 'circle' | 'square' | 'triangle' | 'diamond',
  x: number,
  y: number,
  radius: number,
): string {
  switch (shape) {
    case 'square':
      return `M${r(x - radius)} ${r(y - radius)}h${r(radius * 2)}v${r(radius * 2)}h${r(-radius * 2)}Z`;
    case 'triangle':
      return `M${r(x)} ${r(y - radius * 1.15)}L${r(x + radius * 1.1)} ${r(y + radius * 0.85)}L${r(x - radius * 1.1)} ${r(y + radius * 0.85)}Z`;
    case 'diamond':
      return `M${r(x)} ${r(y - radius * 1.25)}L${r(x + radius * 1.25)} ${r(y)}L${r(x)} ${r(y + radius * 1.25)}L${r(x - radius * 1.25)} ${r(y)}Z`;
    default:
      return `M${r(x - radius)} ${r(y)}a${r(radius)} ${r(radius)} 0 1 0 ${r(radius * 2)} 0a${r(radius)} ${r(radius)} 0 1 0 ${r(-radius * 2)} 0Z`;
  }
}
