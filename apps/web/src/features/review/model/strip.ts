import { formatDuration } from '@caseguard/ui';
import { LANES, type Chronology, type KeyReason, type LaneId } from './chronology';

/**
 * Where everything goes on the chronology strip. Pure geometry from the chronology, so the drawing component only draws
 * and the layout (no two markers on top of each other, labels only where there is room) is unit-tested.
 */

export const STRIP = {
  width: 960,
  left: 112,
  right: 24,
  top: 8,
  decisionRow: 60,
  laneRow: 56,
  axisRow: 40,
} as const;

export type StripShape = 'circle' | 'square' | 'triangle' | 'diamond';

export interface StripMarker {
  id: string;
  kind: 'event' | 'decision';
  lane: LaneId | 'decisions';
  shape: StripShape;
  x: number;
  y: number;
  /** The decision point number drawn inside a diamond. */
  number: number | null;
  title: string;
  reasons: KeyReason[];
}

export interface StripRow {
  id: LaneId | 'decisions';
  label: string;
  y: number;
  height: number;
}

export interface StripGeometry {
  width: number;
  height: number;
  rows: StripRow[];
  markers: StripMarker[];
  /** Events that are not key: a quiet tick in their lane. */
  ticks: { id: string; lane: LaneId; x: number; y1: number; y2: number }[];
  waits: { id: string; x: number; width: number; label: string | null; text: string }[];
  axis: { y: number; days: { x: number; label: string }[] };
  plot: { x1: number; x2: number; y1: number; y2: number };
}

/**
 * The level (0, 1, 2...) each marker is drawn at so that none lands within `minGap` of another on the same level.
 * `xs` ascend. A marker takes the lowest level whose last marker is far enough away; when every level is taken it uses
 * the one whose last marker is furthest.
 */
export function staggerLevels(xs: readonly number[], minGap: number, levels: number): number[] {
  const last: number[] = Array.from({ length: levels }, () => Number.NEGATIVE_INFINITY);
  return xs.map((x) => {
    let chosen = last.findIndex((at) => x - at >= minGap);
    if (chosen === -1) {
      chosen = last.reduce((best, at, index) => (at < (last[best] ?? Infinity) ? index : best), 0);
    }
    last[chosen] = x;
    return chosen;
  });
}

const LEVEL_OFFSETS = [0, -15, 15] as const;
const SHAPES: Record<LaneId, StripShape> = {
  customer: 'circle',
  engineer: 'square',
  system: 'triangle',
};

export function layoutStrip(chronology: Chronology): StripGeometry {
  const { left, right, width, top, decisionRow, laneRow, axisRow } = STRIP;
  const x = (position: number): number => left + position * (width - left - right);

  const rows: StripRow[] = [
    { id: 'decisions', label: 'Decision points', y: top, height: decisionRow },
    ...LANES.map((lane, index) => ({
      id: lane.id,
      label: lane.label,
      y: top + decisionRow + index * laneRow,
      height: laneRow,
    })),
  ];
  const center = (row: StripRow): number => row.y + row.height / 2;
  const rowOf = (id: LaneId | 'decisions'): StripRow =>
    rows.find((row) => row.id === id) ?? (rows[0] as StripRow);

  const markers: StripMarker[] = [];

  const points = chronology.decisionPoints
    .map((point) => ({
      point,
      position: chronology.events.find((event) => event.id === point.eventId)?.position,
    }))
    .filter(
      (item): item is { point: (typeof chronology.decisionPoints)[number]; position: number } =>
        item.position !== undefined,
    );
  const decisionLevels = staggerLevels(
    points.map((item) => x(item.position)),
    22,
    LEVEL_OFFSETS.length,
  );
  points.forEach((item, index) => {
    markers.push({
      id: `decision-${item.point.number}`,
      kind: 'decision',
      lane: 'decisions',
      shape: 'diamond',
      x: x(item.position),
      y: center(rowOf('decisions')) + (LEVEL_OFFSETS[decisionLevels[index] ?? 0] ?? 0),
      number: item.point.number,
      title: `Decision point ${item.point.number}: ${item.point.title}`,
      reasons: ['decision'],
    });
  });

  for (const lane of LANES) {
    const own = chronology.events.filter((event) => event.lane === lane.id);
    const levels = staggerLevels(
      own.map((event) => x(event.position)),
      16,
      LEVEL_OFFSETS.length,
    );
    own.forEach((event, index) => {
      markers.push({
        id: event.id,
        kind: 'event',
        lane: lane.id,
        shape: SHAPES[lane.id],
        x: x(event.position),
        y: center(rowOf(lane.id)) + (LEVEL_OFFSETS[levels[index] ?? 0] ?? 0),
        number: null,
        title: event.title,
        reasons: event.reasons,
      });
    });
  }

  const plotTop = rowOf('customer').y;
  const plotBottom = rowOf('system').y + rowOf('system').height;
  const waits = chronology.waits.map((wait) => {
    const x1 = x(wait.fromPosition);
    const w = Math.max(2, x(wait.toPosition) - x1);
    return {
      id: `${wait.fromEventId}-${wait.toEventId}`,
      x: x1,
      width: w,
      label: w >= 78 ? formatDuration(wait.minutes) : null,
      text: wait.text,
    };
  });

  const days: StripGeometry['axis']['days'] = [];
  for (const mark of chronology.dayMarks) {
    const at = x(mark.position);
    const previous = days[days.length - 1];
    if (previous && at - previous.x < 44) continue;
    days.push({ x: at, label: mark.label });
  }

  return {
    width,
    height: plotBottom + axisRow,
    rows,
    markers,
    ticks: chronology.otherPositions.map((other) => {
      const row = rowOf(other.lane);
      return {
        id: other.id,
        lane: other.lane,
        x: x(other.position),
        y1: center(row) - 4,
        y2: center(row) + 4,
      };
    }),
    waits,
    axis: { y: plotBottom + 4, days },
    plot: { x1: left, x2: width - right, y1: plotTop, y2: plotBottom },
  };
}
