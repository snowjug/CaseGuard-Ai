import { GRAPH_LANES, type GraphEdge, type GraphNode } from '@caseguard/schemas';

/**
 * Column assignment by time, for graphs whose `order` restarts at 0 in every lane (what `graph.get` returns: "normalise
 * orders per lane"). Raw `order` then says where a node sits inside its own lane but not how lanes line up, so lining
 * columns up by `order` would place a simulated path far from the fork it branches from and the outcomes at the far left.
 *
 * The actual path is the spine: its nodes take consecutive columns. Every other node takes the column of the first spine
 * node that is not earlier than its timestamp, is pushed to the right of anything it follows (an action produced the
 * evidence, a fork starts the simulated path, a fork is where a skill was extracted), and a simulated path stays
 * contiguous. Pure; the caller still guarantees distinct cells per lane.
 */

/** Edge kinds that mean "this happens after that" and so pull the target to the right of its source. */
const FLOW_KINDS: ReadonlySet<GraphEdge['kind']> = new Set([
  'actual',
  'informs',
  'branches',
  'counterfactual',
  'extracts',
]);

/** The lane that carries time: what actually happened. */
export const SPINE_LANE = 'actual';

/** Lanes that are a sequence of steps (apart from the spine) and therefore occupy consecutive columns. */
const CONTIGUOUS_LANES: ReadonlySet<string> = new Set(['counterfactual']);

const laneRank = (lane: string): number => {
  const index = (GRAPH_LANES as readonly string[]).indexOf(lane);
  return index === -1 ? GRAPH_LANES.length : index;
};

const toMs = (timestamp: string | null): number | null => {
  if (timestamp === null) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * True when every lane numbers its own nodes 0..n-1 and more than one lane starts at 0. That is how the API builds a
 * graph, and it is the one shape where `order` alone cannot line lanes up.
 */
export function isLaneLocalOrder(nodes: readonly Pick<GraphNode, 'lane' | 'order'>[]): boolean {
  const byLane = new Map<string, number[]>();
  for (const node of nodes) {
    const orders = byLane.get(node.lane);
    if (orders) orders.push(node.order);
    else byLane.set(node.lane, [node.order]);
  }
  let lanesStartingAtZero = 0;
  for (const orders of byLane.values()) {
    const sorted = [...orders].sort((a, b) => a - b);
    if (!sorted.every((order, index) => order === index)) return false;
    if (sorted.length > 0) lanesStartingAtZero += 1;
  }
  return lanesStartingAtZero > 1;
}

/** `'time'` when the graph is lane-local and its actual path carries timestamps; otherwise `'order'`. */
export function resolveAlignment(
  nodes: readonly Pick<GraphNode, 'lane' | 'order' | 'timestamp'>[],
  requested: 'auto' | 'order' | 'time',
): 'order' | 'time' {
  if (requested !== 'auto') return requested;
  const spineHasTime = nodes.some((n) => n.lane === SPINE_LANE && toMs(n.timestamp) !== null);
  return spineHasTime && isLaneLocalOrder(nodes) ? 'time' : 'order';
}

/**
 * Column per node id, or `null` when the graph has no timed actual path to align on (the caller then falls back to
 * `order`). `nodes` must already be de-duplicated and in reading order (lane, order, time, id).
 */
export function columnsByTime(
  nodes: readonly GraphNode[],
  edges: readonly Pick<GraphEdge, 'from' | 'to' | 'kind'>[],
): Map<string, number> | null {
  const spine = nodes.filter((n) => n.lane === SPINE_LANE);
  const axis = spine.flatMap((node, column) => {
    const t = toMs(node.timestamp);
    return t === null ? [] : [{ t, column }];
  });
  if (axis.length === 0) return null;

  const columns = new Map<string, number>();
  spine.forEach((node, column) => columns.set(node.id, column));

  axis.sort((a, b) => a.t - b.t || a.column - b.column);
  // Smallest spine column among the entries that are not earlier than a given time.
  const suffixMin: number[] = new Array<number>(axis.length).fill(0);
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = axis.length - 1; i >= 0; i--) {
    smallest = Math.min(smallest, axis[i]?.column ?? smallest);
    suffixMin[i] = smallest;
  }
  const timeColumn = (t: number): number => {
    let low = 0;
    let high = axis.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((axis[mid]?.t ?? 0) < t) low = mid + 1;
      else high = mid;
    }
    return low < axis.length ? (suffixMin[low] ?? spine.length) : spine.length;
  };

  const laneOf = new Map(nodes.map((n) => [n.id, n.lane]));
  const sources = new Map<string, string[]>();
  for (const edge of edges) {
    if (!FLOW_KINDS.has(edge.kind) || edge.from === edge.to) continue;
    const list = sources.get(edge.to);
    if (list) list.push(edge.from);
    else sources.set(edge.to, [edge.from]);
  }

  const lanes = [...new Set(nodes.map((n) => n.lane as string))]
    .filter((lane) => lane !== SPINE_LANE)
    .sort((a, b) => laneRank(a) - laneRank(b));

  for (const lane of lanes) {
    const members = nodes.filter((n) => n.lane === lane);
    const orders = [...new Set(members.map((n) => n.order))].sort((a, b) => a - b);
    const wantedBy = new Map<string, number>();
    for (const node of members) {
      const t = toMs(node.timestamp);
      let wanted = t === null ? orders.indexOf(node.order) : timeColumn(t);
      for (const source of sources.get(node.id) ?? []) {
        const column = columns.get(source);
        if (column !== undefined && laneOf.get(source) !== lane)
          wanted = Math.max(wanted, column + 1);
      }
      wantedBy.set(node.id, wanted);
    }

    const contiguous = CONTIGUOUS_LANES.has(lane);
    // A path keeps its own order. In other lanes the node that wants the leftmost column goes first, so two outcomes
    // that belong to different paths each sit at the end of their own path.
    const ordered = contiguous
      ? members
      : [...members].sort(
          (a, b) =>
            (wantedBy.get(a.id) ?? 0) - (wantedBy.get(b.id) ?? 0) ||
            a.order - b.order ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
    const taken = new Set<number>();
    let previous = -1;
    for (const node of ordered) {
      let column = wantedBy.get(node.id) ?? 0;
      if (contiguous && previous >= 0) column = previous + 1;
      while (taken.has(column)) column += 1;
      taken.add(column);
      columns.set(node.id, column);
      previous = column;
    }
  }
  return columns;
}
