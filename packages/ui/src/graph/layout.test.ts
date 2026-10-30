import { GRAPH_LANES } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import {
  apiShapedGraph,
  makeEdge,
  makeGraph,
  makeNode,
  randomGraph,
  sampleGraph,
  shuffled,
} from '../../test/graph-fixtures';
import { columnsByTime, isLaneLocalOrder, resolveAlignment } from './alignment';
import {
  DEFAULT_LAYOUT,
  divergenceFork,
  filterGraphByMode,
  findNeighbour,
  findOverlaps,
  firstFork,
  firstNodeId,
  layoutGraph,
  scenarioForkId,
} from './layout';

const positions = (
  layout: ReturnType<typeof layoutGraph>,
): Record<string, [number, number, number]> =>
  Object.fromEntries(layout.nodes.map((n) => [n.id, [n.x, n.y, n.column]]));

describe('[FR-UX-02] layoutGraph: no overlapping nodes (property tests)', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
    'seed %i: generated graph never overlaps and stays in bounds',
    (seed) => {
      const count = 1 + ((seed * 37) % 160);
      const graph = randomGraph(seed, count);
      const layout = layoutGraph(graph);

      expect(findOverlaps(layout)).toEqual([]);
      expect(layout.nodes).toHaveLength(new Set(graph.nodes.map((n) => n.id)).size);
      for (const n of layout.nodes) {
        expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
        expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
        // The label zone is part of the cell, so a label can never run over another node.
        expect(n.labelBox.x).toBeGreaterThanOrEqual(n.x);
        expect(n.labelBox.x + n.labelBox.width).toBeLessThanOrEqual(n.x + n.width);
        expect(n.labelBox.y).toBeGreaterThanOrEqual(n.y);
        expect(n.labelBox.y + n.labelBox.height).toBeLessThanOrEqual(n.y + n.height);
      }
    },
  );

  it('keeps every lane strictly increasing in column even when orders tie', () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode({ id: `t${i}`, lane: 'evidence', order: 3 }),
    );
    const layout = layoutGraph(makeGraph(nodes, []));
    const columns = layout.nodes.map((n) => n.column).sort((a, b) => a - b);
    expect(columns).toEqual(Array.from({ length: 20 }, (_, i) => columns[0]! + i));
    expect(findOverlaps(layout)).toEqual([]);
  });

  it('only references placed nodes in edges and drops self loops and dangling edges', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'a', lane: 'problem', order: 0 }),
        makeNode({ id: 'b', lane: 'actual', order: 1 }),
      ],
      [
        makeEdge('a', 'b'),
        makeEdge('a', 'a', { id: 'loop' }),
        makeEdge('a', 'ghost', { id: 'dangling' }),
      ],
    );
    const layout = layoutGraph(graph);
    expect(layout.edges.map((e) => e.id)).toEqual(['a->b']);
  });
});

describe('layoutGraph: determinism and structure', () => {
  it('is independent of input array order', () => {
    const graph = randomGraph(7, 90);
    const reference = positions(layoutGraph(graph));
    for (const seed of [1, 2, 3]) {
      const mixed = {
        ...graph,
        nodes: shuffled(graph.nodes, seed),
        edges: shuffled(graph.edges, seed + 10),
      };
      expect(positions(layoutGraph(mixed))).toEqual(reference);
    }
  });

  it('places lanes top to bottom in the documented order and omits empty lanes', () => {
    const layout = layoutGraph(sampleGraph());
    expect(layout.lanes.map((l) => l.id)).toEqual([...GRAPH_LANES]);
    const sparse = layoutGraph(
      makeGraph(
        [
          makeNode({ id: 'x', lane: 'skill', order: 0 }),
          makeNode({ id: 'y', lane: 'problem', order: 0 }),
        ],
        [],
      ),
    );
    expect(sparse.lanes.map((l) => l.id)).toEqual(['problem', 'skill']);
    const withEmpty = layoutGraph(makeGraph([makeNode({ id: 'x', lane: 'skill', order: 0 })], []), {
      includeEmptyLanes: true,
    });
    expect(withEmpty.lanes).toHaveLength(GRAPH_LANES.length);
    const ys = layout.lanes.map((l) => l.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('uses the dense rank of `order` for columns, so sparse orders do not create empty columns', () => {
    const nodes = [0, 100, 5000].map((order, i) =>
      makeNode({ id: `s${i}`, lane: 'actual', order }),
    );
    const layout = layoutGraph(makeGraph(nodes, []));
    expect(layout.columns).toBe(3);
    expect(layout.width).toBeLessThan(
      DEFAULT_LAYOUT.gutter +
        DEFAULT_LAYOUT.padding * 2 +
        3 * (DEFAULT_LAYOUT.cellWidth + DEFAULT_LAYOUT.columnGap),
    );
  });

  it('aligns nodes from different lanes that share an order into the same column', () => {
    const layout = layoutGraph(sampleGraph());
    expect(layout.nodeById.get('h2')?.column).toBe(layout.nodeById.get('fork')?.column);
  });

  it('removes duplicate ids deterministically', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'dup', lane: 'actual', order: 1, label: 'first' }),
        makeNode({ id: 'dup', lane: 'actual', order: 2, label: 'second' }),
      ],
      [],
    );
    expect(layoutGraph(graph).nodes).toHaveLength(1);
  });

  it('returns a valid empty layout', () => {
    const layout = layoutGraph(makeGraph([], []));
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(findOverlaps(layout)).toEqual([]);
  });
});

describe('[FR-UX-02] layoutGraph: bounded to 160 nodes', () => {
  it('lays out exactly 160 nodes without overlap and quickly', () => {
    const graph = randomGraph(99, 160);
    const unique = new Set(graph.nodes.map((n) => n.id)).size;
    expect(unique).toBe(160);
    const start = performance.now();
    const layout = layoutGraph(graph);
    const elapsed = performance.now() - start;
    expect(layout.nodes).toHaveLength(160);
    expect(layout.truncated).toBe(false);
    expect(findOverlaps(layout)).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('drops the tail beyond the bound and reports it', () => {
    const layout = layoutGraph(randomGraph(5, 200));
    expect(layout.nodes).toHaveLength(160);
    expect(layout.truncated).toBe(true);
    expect(layout.omittedNodeCount).toBe(40);
    expect(findOverlaps(layout)).toEqual([]);
  });

  it('honours a custom bound', () => {
    const layout = layoutGraph(randomGraph(5, 50), { maxNodes: 10 });
    expect(layout.nodes).toHaveLength(10);
    expect(layout.omittedNodeCount).toBe(40);
  });
});

describe('findNeighbour (arrow-key navigation)', () => {
  const nodes = [
    makeNode({ id: 'P', lane: 'problem', order: 0 }),
    makeNode({ id: 'E1', lane: 'evidence', order: 0 }),
    makeNode({ id: 'E2', lane: 'evidence', order: 1 }),
    makeNode({ id: 'H1', lane: 'hypothesis', order: 1 }),
    makeNode({ id: 'H2', lane: 'hypothesis', order: 3 }),
  ];
  const layout = layoutGraph(makeGraph(nodes, []));

  it('moves right and left within a lane to the nearest node', () => {
    expect(findNeighbour(layout, 'E1', 'right')).toBe('E2');
    expect(findNeighbour(layout, 'E2', 'left')).toBe('E1');
    expect(findNeighbour(layout, 'H1', 'right')).toBe('H2');
  });

  it('moves down to the nearest lane and picks the closest column', () => {
    expect(findNeighbour(layout, 'P', 'down')).toBe('E1');
    expect(findNeighbour(layout, 'E2', 'down')).toBe('H1');
    expect(findNeighbour(layout, 'E2', 'up')).toBe('P');
  });

  it('returns null at the edges and for unknown nodes', () => {
    expect(findNeighbour(layout, 'P', 'up')).toBeNull();
    expect(findNeighbour(layout, 'H2', 'right')).toBeNull();
    expect(findNeighbour(layout, 'missing', 'right')).toBeNull();
  });

  it('can leave a lane sideways when nothing is left in the row', () => {
    // Nothing to the right of E2 in its lane, but H2 sits further right in another lane.
    expect(findNeighbour(layout, 'E2', 'right')).toBe('H2');
  });

  it('starts keyboard focus on the first node in reading order', () => {
    expect(firstNodeId(layout)).toBe('P');
    expect(firstNodeId({ nodes: [] })).toBeNull();
  });
});

describe('filterGraphByMode', () => {
  const graph = sampleGraph();

  it('actual hides simulated nodes and edges', () => {
    const view = filterGraphByMode(graph, 'actual');
    expect(view.nodes.some((n) => n.simulated || n.kind === 'counterfactual_step')).toBe(false);
    expect(view.edges.some((e) => e.simulated)).toBe(false);
    expect(view.nodes.map((n) => n.id)).toContain('a3');
  });

  it('counterfactual keeps the actual path only up to the fork', () => {
    const view = filterGraphByMode(graph, 'counterfactual');
    const ids = view.nodes.map((n) => n.id);
    expect(ids).toContain('fork');
    expect(ids).toContain('s1');
    expect(ids).not.toContain('a3');
    expect(view.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true);
  });

  it('compare keeps everything and the fork is found for the divergence marker', () => {
    const view = filterGraphByMode(graph, 'compare');
    expect(view.nodes).toHaveLength(graph.nodes.length);
    expect(firstFork(layoutGraph(view))?.id).toBe('fork');
  });
});

describe('graph from the API: lane-local order, time alignment and the scenario fork', () => {
  const graph = apiShapedGraph();
  const timed = layoutGraph(graph, { alignment: 'time' });
  const column = (id: string): number => timed.nodeById.get(id)?.column ?? Number.NaN;

  it('recognises lane-local numbering and keeps `order` for graphs that share one numbering', () => {
    expect(isLaneLocalOrder(graph.nodes)).toBe(true);
    expect(isLaneLocalOrder(sampleGraph().nodes)).toBe(false);
    expect(resolveAlignment(graph.nodes, 'auto')).toBe('time');
    expect(resolveAlignment(sampleGraph().nodes, 'auto')).toBe('order');
    expect(resolveAlignment(sampleGraph().nodes, 'time')).toBe('time');
    expect(resolveAlignment(graph.nodes, 'order')).toBe('order');
    const untimed = graph.nodes.map((n) => ({ ...n, timestamp: null }));
    expect(resolveAlignment(untimed, 'auto')).toBe('order');
  });

  it('never overlaps nodes and is independent of input order', () => {
    expect(findOverlaps(timed)).toEqual([]);
    const reference = positions(timed);
    for (const seed of [1, 2, 3]) {
      const mixed = {
        ...graph,
        nodes: shuffled(graph.nodes, seed),
        edges: shuffled(graph.edges, seed + 10),
      };
      expect(positions(layoutGraph(mixed, { alignment: 'time' }))).toEqual(reference);
    }
  });

  it('starts the simulated path under the fork it branches from and keeps it contiguous', () => {
    const fork = column('fork:f2');
    expect(column('step:s1')).toBeGreaterThan(fork);
    expect(column('step:s2')).toBe(column('step:s1') + 1);
    expect(column('step:s3')).toBe(column('step:s2') + 1);
    expect(column('outcome:sim:scn')).toBeGreaterThan(column('step:s3'));
    // Without time alignment the same path starts at the far left, nowhere near its fork: the problem this fixes.
    const byOrder = layoutGraph(graph);
    expect(byOrder.nodeById.get('step:s1')?.column).toBeLessThan(
      byOrder.nodeById.get('fork:f2')?.column ?? 0,
    );
  });

  it('puts outcomes after the path they end, the skill after its fork and evidence after its action', () => {
    expect(column('outcome:actual')).toBeGreaterThan(column('action:a4'));
    expect(column('skill:sk1')).toBeGreaterThan(column('fork:f2'));
    expect(column('evidence:ev2')).toBeGreaterThan(column('action:a2'));
    expect(column('evidence:ev4')).toBeGreaterThan(column('action:a4'));
    // The actual path is the spine: consecutive columns in order.
    const spine = ['action:a1', 'action:a2', 'fork:f1', 'action:a3', 'fork:f2', 'action:a4'];
    expect(spine.map(column)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('falls back to `order` when the actual path has no timestamps', () => {
    const untimed = graph.nodes.map((n) => ({ ...n, timestamp: null }));
    expect(columnsByTime(untimed, graph.edges)).toBeNull();
    const layout = layoutGraph({ ...graph, nodes: untimed }, { alignment: 'time' });
    expect(findOverlaps(layout)).toEqual([]);
  });

  it('draws the divergence at the fork of the scenario, not at the earliest fork', () => {
    expect(scenarioForkId(graph)).toBe('fork:f2');
    expect(divergenceFork(timed)?.id).toBe('fork:f2');
    expect(firstFork(timed)?.id).toBe('fork:f1');
    expect(scenarioForkId({ nodes: sampleGraph().nodes, edges: sampleGraph().edges })).toBe('fork');
  });

  it('counterfactual mode keeps the history up to the scenario fork and nothing that came later', () => {
    const view = filterGraphByMode(graph, 'counterfactual');
    const ids = view.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['fork:f1', 'fork:f2', 'step:s1', 'evidence:ev2']));
    expect(ids).not.toContain('action:a4');
    expect(ids).not.toContain('evidence:ev3');
    expect(ids).not.toContain('evidence:ev4');
    expect(ids).not.toContain('outcome:actual');
    expect(ids).toContain('outcome:sim:scn');
    expect(view.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true);
  });
});
