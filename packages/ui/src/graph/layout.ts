import { GRAPH_LANES, type GraphEdge, type GraphLane, type GraphNode } from '@caseguard/schemas';

/**
 * Deterministic lane layout for the investigation graph. Pure (no DOM, no React) so it can be property-tested.
 *
 * Lanes run top to bottom (problem, evidence, hypothesis, actual, counterfactual, outcome, skill). Columns are the
 * dense rank of each node's `order`. Inside a lane a node never shares a column with another node (ties are pushed to
 * the next free column), so each node owns a distinct (lane, column) cell and cells never overlap.
 */

/** The slice of `InvestigationGraph` the layout needs. */
export interface GraphLayoutInput {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** Lane labels from the API; defaults are used for missing ones. */
  lanes?: readonly { id: GraphLane; label: string }[];
}

export interface LayoutOptions {
  /** Width of a node cell (shape plus label). */
  cellWidth?: number;
  /** Height of a node cell. */
  cellHeight?: number;
  /** Horizontal gap between cells. */
  columnGap?: number;
  /** Vertical gap between lanes. */
  laneGap?: number;
  /** Outer padding. */
  padding?: number;
  /** Width reserved on the left for lane labels. */
  gutter?: number;
  /** Height reserved above the first lane for annotations (compare-mode divergence tag). */
  headerHeight?: number;
  /** Maximum nodes laid out; the rest are dropped and reported (the API also bounds the graph to 160). */
  maxNodes?: number;
  /** Keep lanes that have no nodes (default false). */
  includeEmptyLanes?: boolean;
}

export const DEFAULT_LAYOUT: Required<LayoutOptions> = {
  cellWidth: 148,
  cellHeight: 116,
  columnGap: 28,
  laneGap: 24,
  padding: 20,
  gutter: 108,
  headerHeight: 0,
  maxNodes: 160,
  includeEmptyLanes: false,
};

/** Vertical position of the shape centre inside a cell. */
export const SHAPE_CENTER_Y = 30;

export const LANE_LABELS: Record<GraphLane, string> = {
  problem: 'Problem',
  evidence: 'Evidence',
  hypothesis: 'Hypotheses',
  actual: 'Actual path',
  counterfactual: 'Simulated path',
  outcome: 'Outcome',
  skill: 'SkillDNA',
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutNode extends Rect {
  id: string;
  node: GraphNode;
  lane: GraphLane;
  laneIndex: number;
  column: number;
  /** Shape centre. */
  cx: number;
  cy: number;
  /** Region reserved for the (truncated) label under the shape. It is always inside the cell. */
  labelBox: Rect;
}

export interface LayoutEdge {
  id: string;
  edge: GraphEdge;
  from: string;
  to: string;
}

export interface LayoutLane {
  id: GraphLane;
  label: string;
  index: number;
  y: number;
  height: number;
  nodeCount: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  lanes: LayoutLane[];
  /** Total canvas size. */
  width: number;
  height: number;
  columns: number;
  /** True when more than `maxNodes` nodes were supplied and the tail was dropped. */
  truncated: boolean;
  omittedNodeCount: number;
  nodeById: ReadonlyMap<string, LayoutNode>;
  options: Required<LayoutOptions>;
}

const laneRank = (lane: string): number => {
  const index = (GRAPH_LANES as readonly string[]).indexOf(lane);
  return index === -1 ? GRAPH_LANES.length : index;
};

const compareNodes = (a: GraphNode, b: GraphNode): number =>
  laneRank(a.lane) - laneRank(b.lane) ||
  a.order - b.order ||
  (a.timestamp ?? '').localeCompare(b.timestamp ?? '') ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Reading order shared by the layout, keyboard focus and the text alternative: lane, then order, then time, then id. */
export const compareNodesForReading = compareNodes;

/**
 * Lays out the graph. Deterministic: the result depends only on the node and edge *content*, not on array order.
 * Guarantees: no two nodes' cells overlap, every cell lies inside `width` x `height`, and at most `maxNodes` are placed.
 */
export function layoutGraph(graph: GraphLayoutInput, options: LayoutOptions = {}): GraphLayout {
  const o: Required<LayoutOptions> = { ...DEFAULT_LAYOUT, ...options };

  const sorted = [...graph.nodes].sort(compareNodes);
  const unique: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }

  // Global order decides who is dropped when over the bound: keep the earliest nodes of the investigation.
  let kept = unique;
  let omitted = 0;
  if (unique.length > o.maxNodes) {
    kept = [...unique]
      .sort((a, b) => a.order - b.order || compareNodes(a, b))
      .slice(0, o.maxNodes)
      .sort(compareNodes);
    omitted = unique.length - kept.length;
  }

  const labelFor = new Map<string, string>(graph.lanes?.map((lane) => [lane.id, lane.label]) ?? []);
  const laneIds = [...new Set(kept.map((n) => n.lane as string))].sort(
    (a, b) => laneRank(a) - laneRank(b),
  );
  const allLaneIds: string[] = o.includeEmptyLanes
    ? [...GRAPH_LANES, ...laneIds.filter((id) => !(GRAPH_LANES as readonly string[]).includes(id))]
    : laneIds;

  const orders = [...new Set(kept.map((n) => n.order))].sort((a, b) => a - b);
  const rank = new Map<number, number>(orders.map((order, index) => [order, index]));

  const lastColumn = new Map<string, number>();
  const placed: LayoutNode[] = [];
  const columnPitch = o.cellWidth + o.columnGap;
  const lanePitch = o.cellHeight + o.laneGap;
  const originX = o.padding + o.gutter;
  const originY = o.padding + o.headerHeight;
  let maxColumn = -1;

  for (const node of kept) {
    const laneIndex = allLaneIds.indexOf(node.lane);
    const wanted = rank.get(node.order) ?? 0;
    const column = Math.max(wanted, (lastColumn.get(node.lane) ?? -1) + 1);
    lastColumn.set(node.lane, column);
    maxColumn = Math.max(maxColumn, column);
    const x = originX + column * columnPitch;
    const y = originY + laneIndex * lanePitch;
    placed.push({
      id: node.id,
      node,
      lane: node.lane,
      laneIndex,
      column,
      x,
      y,
      width: o.cellWidth,
      height: o.cellHeight,
      cx: x + o.cellWidth / 2,
      cy: y + SHAPE_CENTER_Y,
      labelBox: {
        x: x + 4,
        y: y + SHAPE_CENTER_Y + 32,
        width: o.cellWidth - 8,
        height: o.cellHeight - SHAPE_CENTER_Y - 36,
      },
    });
  }

  const nodeById = new Map(placed.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = [...graph.edges]
    .filter((e) => e.from !== e.to && nodeById.has(e.from) && nodeById.has(e.to))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => ({ id: edge.id, edge, from: edge.from, to: edge.to }));

  const lanes: LayoutLane[] = allLaneIds.map((id, index) => ({
    id: id as GraphLane,
    label: labelFor.get(id) ?? LANE_LABELS[id as GraphLane] ?? id,
    index,
    y: originY + index * lanePitch,
    height: o.cellHeight,
    nodeCount: placed.filter((n) => n.lane === id).length,
  }));

  const columns = maxColumn + 1;
  const width = originX + Math.max(columns, 1) * columnPitch - o.columnGap + o.padding;
  const height = originY + Math.max(allLaneIds.length, 1) * lanePitch - o.laneGap + o.padding;

  return {
    nodes: placed,
    edges,
    lanes,
    width,
    height,
    columns,
    truncated: omitted > 0,
    omittedNodeCount: omitted,
    nodeById,
    options: o,
  };
}

/** Pairs of nodes whose cells intersect. Empty for every layout produced by `layoutGraph` (the guarantee under test). */
export function findOverlaps(layout: Pick<GraphLayout, 'nodes'>): [string, string][] {
  const overlaps: [string, string][] = [];
  const { nodes } = layout;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (!b) continue;
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      if (!apart) overlaps.push([a.id, b.id]);
    }
  }
  return overlaps;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Nearest node from `fromId` in the arrow-key direction.
 * Left/right prefer the same lane (nearest by distance), falling back to the best weighted match in other lanes.
 * Up/down go to the nearest lane in that direction and pick the node closest in x.
 */
export function findNeighbour(
  layout: Pick<GraphLayout, 'nodes' | 'nodeById'>,
  fromId: string,
  direction: Direction,
): string | null {
  const from = layout.nodeById.get(fromId);
  if (!from) return null;
  const others = layout.nodes.filter((n) => n.id !== from.id);

  if (direction === 'up' || direction === 'down') {
    const sign = direction === 'down' ? 1 : -1;
    const candidates = others.filter((n) => (n.cy - from.cy) * sign > 0);
    if (candidates.length === 0) return null;
    const nearestRow = Math.min(...candidates.map((n) => Math.abs(n.cy - from.cy)));
    const row = candidates.filter((n) => Math.abs(n.cy - from.cy) === nearestRow);
    return pickClosest(
      row,
      (n) => Math.abs(n.cx - from.cx),
      (n) => n.cx,
    );
  }

  const sign = direction === 'right' ? 1 : -1;
  const ahead = others.filter((n) => (n.cx - from.cx) * sign > 0);
  const sameRow = ahead.filter((n) => n.cy === from.cy);
  if (sameRow.length > 0)
    return pickClosest(
      sameRow,
      (n) => Math.abs(n.cx - from.cx),
      (n) => n.cx * sign,
    );
  if (ahead.length === 0) return null;
  return pickClosest(
    ahead,
    (n) => Math.abs(n.cx - from.cx) + 2.5 * Math.abs(n.cy - from.cy),
    (n) => n.cy,
  );
}

function pickClosest(
  candidates: readonly LayoutNode[],
  score: (n: LayoutNode) => number,
  tie: (n: LayoutNode) => number,
): string | null {
  let best: LayoutNode | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    const delta = score(candidate) - score(best);
    if (
      delta < 0 ||
      (delta === 0 &&
        (tie(candidate) < tie(best) || (tie(candidate) === tie(best) && candidate.id < best.id)))
    ) {
      best = candidate;
    }
  }
  return best?.id ?? null;
}

/** First node in reading order (lane order, then column): where keyboard focus lands. */
export function firstNodeId(layout: Pick<GraphLayout, 'nodes'>): string | null {
  const first = [...layout.nodes].sort(
    (a, b) => a.laneIndex - b.laneIndex || a.column - b.column || (a.id < b.id ? -1 : 1),
  )[0];
  return first?.id ?? null;
}

export type GraphMode = 'actual' | 'counterfactual' | 'compare';

/**
 * Applies the view mode. `actual` hides simulated nodes and edges; `counterfactual` hides the actual path after the
 * first decision fork (the shared history up to the fork stays so the branch has a visible origin); `compare` keeps
 * everything.
 */
export function filterGraphByMode<T extends GraphLayoutInput>(
  graph: T,
  mode: GraphMode,
): { nodes: GraphNode[]; edges: GraphEdge[]; lanes: GraphLayoutInput['lanes'] } {
  const base = { lanes: graph.lanes };
  if (mode === 'compare') return { ...base, nodes: [...graph.nodes], edges: [...graph.edges] };
  let nodes: GraphNode[];
  if (mode === 'actual') {
    nodes = graph.nodes.filter((n) => !n.simulated && n.kind !== 'counterfactual_step');
  } else {
    const forkOrder = firstForkOrder(graph.nodes);
    nodes = graph.nodes.filter(
      (n) => !(n.lane === 'actual' && forkOrder !== null && n.order > forkOrder),
    );
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && (mode !== 'actual' || !e.simulated),
  );
  return { ...base, nodes, edges };
}

/** `order` of the earliest decision fork, or null. */
export function firstForkOrder(nodes: readonly GraphNode[]): number | null {
  let order: number | null = null;
  for (const node of nodes) {
    if (node.kind === 'fork' && (order === null || node.order < order)) order = node.order;
  }
  return order;
}

/** The earliest fork node in a layout (compare mode anchors the divergence marker on it). */
export function firstFork(layout: Pick<GraphLayout, 'nodes'>): LayoutNode | null {
  let fork: LayoutNode | null = null;
  for (const node of layout.nodes) {
    if (node.node.kind !== 'fork') continue;
    if (!fork || node.column < fork.column || (node.column === fork.column && node.id < fork.id))
      fork = node;
  }
  return fork;
}
