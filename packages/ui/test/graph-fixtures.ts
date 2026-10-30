import {
  GRAPH_LANES,
  type GraphEdge,
  type GraphLane,
  type GraphNode,
  type InvestigationGraph,
} from '@caseguard/schemas';

/** Small seeded PRNG (mulberry32) so property-style tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KIND_FOR_LANE: Record<GraphLane, GraphNode['kind']> = {
  problem: 'problem',
  evidence: 'evidence',
  hypothesis: 'hypothesis',
  actual: 'action',
  counterfactual: 'counterfactual_step',
  outcome: 'outcome',
  skill: 'skill',
};

type NodeInput = Partial<GraphNode> & Pick<GraphNode, 'id' | 'lane' | 'order'>;

export function makeNode(input: NodeInput): GraphNode {
  return {
    kind: KIND_FOR_LANE[input.lane],
    label: `Node ${input.id}`,
    detail: `Detail for ${input.id}`,
    timestamp: null,
    status: 'neutral',
    simulated: input.lane === 'counterfactual',
    confidence: null,
    refs: [],
    textAlternative: `${input.id} in the ${input.lane} lane`,
    ...input,
  };
}

export function makeEdge(from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: 'informs',
    label: null,
    simulated: false,
    strength: null,
    ...extra,
  };
}

export function makeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  extra: Partial<InvestigationGraph> = {},
): InvestigationGraph {
  return {
    caseId: 'case_sample',
    scenarioId: null,
    asOf: null,
    generatedAt: '2025-03-14T09:00:00Z',
    nodes,
    edges,
    lanes: GRAPH_LANES.map((id) => ({ id, label: id })),
    summary: `Synthetic test graph with ${nodes.length} nodes and ${edges.length} connections.`,
    truncated: false,
    nodeLimit: 160,
    ...extra,
  };
}

/** Random graph with deliberate order ties, sparse orders, duplicate edges and dangling edges. */
export function randomGraph(seed: number, nodeCount: number): InvestigationGraph {
  const random = mulberry32(seed);
  const statuses: GraphNode['status'][] = [
    'productive',
    'uncertain',
    'unsupported',
    'missing',
    'neutral',
  ];
  const nodes: GraphNode[] = [];
  const maxOrder = Math.max(2, Math.floor(nodeCount / 2));
  for (let i = 0; i < nodeCount; i++) {
    const lane = GRAPH_LANES[Math.floor(random() * GRAPH_LANES.length)] ?? 'actual';
    const sparse = random() < 0.2 ? Math.floor(random() * 5000) : Math.floor(random() * maxOrder);
    nodes.push(
      makeNode({
        id: `n${i}`,
        lane,
        order: sparse,
        timestamp:
          random() < 0.5
            ? new Date(Date.UTC(2025, 2, 1) + Math.floor(random() * 1e9)).toISOString()
            : null,
        status: statuses[Math.floor(random() * statuses.length)] ?? 'neutral',
        label: `Label ${i} ${'word '.repeat(Math.floor(random() * 12))}`.trim(),
        confidence: lane === 'hypothesis' ? random() : null,
      }),
    );
  }
  const edges: GraphEdge[] = [];
  const edgeCount = Math.floor(nodeCount * 1.5);
  for (let i = 0; i < edgeCount; i++) {
    const from = Math.floor(random() * (nodeCount + 2));
    const to = Math.floor(random() * (nodeCount + 2));
    edges.push(
      makeEdge(`n${from}`, `n${to}`, {
        id: `e${i}`,
        kind:
          (['actual', 'supports', 'contradicts', 'informs', 'branches'] as const)[
            Math.floor(random() * 5)
          ] ?? 'informs',
      }),
    );
  }
  return makeGraph(nodes, edges);
}

/** Seeded Fisher-Yates shuffle. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}

/** Hand-written investigation: an actual path with a fork, a simulated branch and a skill. */
export function sampleGraph(): InvestigationGraph {
  const nodes = [
    makeNode({
      id: 'problem',
      lane: 'problem',
      order: 0,
      label: 'Users cannot sign in after the proxy change',
      status: 'neutral',
    }),
    makeNode({
      id: 'ev1',
      lane: 'evidence',
      order: 1,
      label: 'Sign-in errors begin at 08:02',
      status: 'productive',
    }),
    makeNode({
      id: 'ev2',
      lane: 'evidence',
      order: 3,
      label: 'Customer reports a recent proxy update',
      status: 'uncertain',
    }),
    makeNode({
      id: 'ev3',
      lane: 'evidence',
      order: 5,
      label: 'Proxy trace shows 407 responses',
      status: 'productive',
    }),
    makeNode({
      id: 'ev4',
      lane: 'evidence',
      order: 6,
      label: 'Missing: client trace from an affected device',
      status: 'missing',
    }),
    makeNode({
      id: 'h1',
      lane: 'hypothesis',
      order: 2,
      label: 'Proxy authentication misconfiguration',
      status: 'uncertain',
      confidence: 0.55,
    }),
    makeNode({
      id: 'h2',
      lane: 'hypothesis',
      order: 4,
      label: 'Expired client certificate',
      status: 'unsupported',
      confidence: 0.12,
    }),
    makeNode({
      id: 'a1',
      lane: 'actual',
      order: 1,
      label: 'Request recent sign-in logs',
      status: 'productive',
    }),
    makeNode({
      id: 'a2',
      lane: 'actual',
      order: 3,
      label: 'Ask customer to reinstall the client',
      status: 'unsupported',
    }),
    makeNode({
      id: 'fork',
      lane: 'actual',
      order: 4,
      kind: 'fork',
      label: 'Reinstall chosen before checking the proxy',
      status: 'uncertain',
    }),
    makeNode({
      id: 'a3',
      lane: 'actual',
      order: 7,
      label: 'Escalate to the network team',
      status: 'neutral',
    }),
    makeNode({
      id: 's1',
      lane: 'counterfactual',
      order: 5,
      label: 'Capture proxy trace for one affected user',
      status: 'productive',
    }),
    makeNode({
      id: 's2',
      lane: 'counterfactual',
      order: 6,
      label: 'Compare proxy authentication settings',
      status: 'productive',
    }),
    makeNode({
      id: 'out1',
      lane: 'outcome',
      order: 8,
      label: 'Resolved after 9 days',
      status: 'neutral',
    }),
    makeNode({
      id: 'out2',
      lane: 'outcome',
      order: 7,
      label: 'Simulated: resolved after 3 days',
      status: 'productive',
      simulated: true,
    }),
    makeNode({
      id: 'skill',
      lane: 'skill',
      order: 9,
      label: 'Check proxy authentication before client reinstall',
      status: 'productive',
    }),
  ];
  const edges = [
    makeEdge('problem', 'a1', { kind: 'actual' }),
    makeEdge('a1', 'a2', { kind: 'actual' }),
    makeEdge('a2', 'fork', { kind: 'actual' }),
    makeEdge('fork', 'a3', { kind: 'actual' }),
    makeEdge('a3', 'out1', { kind: 'actual' }),
    makeEdge('fork', 's1', { kind: 'branches', simulated: true }),
    makeEdge('s1', 's2', { kind: 'counterfactual', simulated: true }),
    makeEdge('s2', 'out2', { kind: 'counterfactual', simulated: true }),
    makeEdge('ev3', 'h1', { kind: 'supports' }),
    makeEdge('ev2', 'h2', { kind: 'contradicts' }),
    makeEdge('out2', 'skill', { kind: 'extracts' }),
  ];
  return makeGraph(nodes, edges, {
    scenarioId: 'scenario_1',
    summary:
      'A support case where a client reinstall was chosen before checking the proxy. The simulated path checks the proxy first and resolves sooner.',
  });
}
