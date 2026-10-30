import {
  GRAPH_LANES,
  type GraphEdge,
  type GraphNode,
  type InvestigationGraph,
} from '@caseguard/schemas';

/**
 * STATIC SAMPLE DATA for the development-only design lab. It exists so the graph, charts and primitives can be looked
 * at and axe-checked without an API. It is never imported by a product page and must not be reused as product data.
 */

type Lane = GraphNode['lane'];
type Status = GraphNode['status'];

const KIND: Record<Lane, GraphNode['kind']> = {
  problem: 'problem',
  evidence: 'evidence',
  hypothesis: 'hypothesis',
  actual: 'action',
  counterfactual: 'counterfactual_step',
  outcome: 'outcome',
  skill: 'skill',
};

interface NodeSpec {
  id: string;
  lane: Lane;
  order: number;
  label: string;
  status: Status;
  kind?: GraphNode['kind'];
  confidence?: number;
  simulated?: boolean;
  day?: number;
}

const DAY_MS = 86_400_000;
const START = Date.UTC(2025, 2, 3, 8, 0, 0);

function node(spec: NodeSpec): GraphNode {
  const simulated = spec.simulated ?? spec.lane === 'counterfactual';
  return {
    id: spec.id,
    kind: spec.kind ?? KIND[spec.lane],
    lane: spec.lane,
    label: spec.label,
    detail: `${spec.label}. Static sample for the design lab.`,
    order: spec.order,
    timestamp: spec.day === undefined ? null : new Date(START + spec.day * DAY_MS).toISOString(),
    status: spec.status,
    simulated,
    confidence: spec.confidence ?? null,
    refs: [],
    textAlternative: `${simulated ? 'Simulated ' : ''}${spec.label}, ${spec.status}.`,
  };
}

function edge(
  from: string,
  to: string,
  kind: GraphEdge['kind'],
  extra: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id: `${from}>${to}`,
    from,
    to,
    kind,
    label: null,
    simulated: kind === 'counterfactual' || kind === 'branches' || kind === 'extracts',
    strength: null,
    ...extra,
  };
}

const NODES: GraphNode[] = [
  node({
    id: 'p1',
    lane: 'problem',
    order: 0,
    label: 'Intermittent sign-in failures for 400 users',
    status: 'neutral',
    day: 0,
  }),

  node({
    id: 'e1',
    lane: 'evidence',
    order: 1,
    label: 'Failure rate spikes at 08:02 UTC',
    status: 'productive',
    day: 0,
  }),
  node({
    id: 'e2',
    lane: 'evidence',
    order: 2,
    label: 'Customer says the proxy was updated on 1 March',
    status: 'uncertain',
    day: 1,
  }),
  node({
    id: 'e3',
    lane: 'evidence',
    order: 4,
    label: 'Sign-in logs show repeated 407 responses',
    status: 'productive',
    day: 1,
  }),
  node({
    id: 'e4',
    lane: 'evidence',
    order: 5,
    label: 'Only remote-office users are affected',
    status: 'productive',
    day: 2,
  }),
  node({
    id: 'e5',
    lane: 'evidence',
    order: 7,
    label: 'Client reinstall did not change the failure rate',
    status: 'productive',
    day: 4,
  }),
  node({
    id: 'e6',
    lane: 'evidence',
    order: 8,
    label: 'Network team finds a PAC file change',
    status: 'productive',
    day: 6,
  }),
  node({
    id: 'e7',
    lane: 'evidence',
    order: 9,
    label: 'Missing: client trace from an affected device',
    status: 'missing',
    day: 6,
  }),
  node({
    id: 'e8',
    lane: 'evidence',
    order: 10,
    label: 'Missing: proxy authentication policy export',
    status: 'missing',
    day: 6,
  }),
  node({
    id: 'e9',
    lane: 'evidence',
    order: 12,
    label: 'Customer reports the PAC file was unchanged',
    status: 'unsupported',
    day: 7,
  }),
  node({
    id: 'e10',
    lane: 'evidence',
    order: 13,
    label: 'Proxy trace captured after escalation',
    status: 'productive',
    day: 8,
  }),
  node({
    id: 'e11',
    lane: 'evidence',
    order: 14,
    label: 'Sign-in success rate returns to normal',
    status: 'productive',
    day: 9,
  }),

  node({
    id: 'h1',
    lane: 'hypothesis',
    order: 3,
    label: 'Proxy authentication misconfiguration',
    status: 'uncertain',
    confidence: 0.58,
  }),
  node({
    id: 'h2',
    lane: 'hypothesis',
    order: 4,
    label: 'Expired client certificate',
    status: 'unsupported',
    confidence: 0.12,
  }),
  node({
    id: 'h3',
    lane: 'hypothesis',
    order: 6,
    label: 'Client version regression',
    status: 'unsupported',
    confidence: 0.21,
  }),
  node({
    id: 'h4',
    lane: 'hypothesis',
    order: 9,
    label: 'PAC file routes sign-in through the wrong proxy',
    status: 'uncertain',
    confidence: 0.64,
  }),

  node({
    id: 'a1',
    lane: 'actual',
    order: 1,
    label: 'Request recent sign-in logs',
    status: 'productive',
    day: 0,
  }),
  node({
    id: 'a2',
    lane: 'actual',
    order: 2,
    label: 'Ask about recent changes',
    status: 'productive',
    day: 1,
  }),
  node({
    id: 'a3',
    lane: 'actual',
    order: 3,
    label: 'Review service health',
    status: 'neutral',
    day: 1,
  }),
  node({
    id: 'a4',
    lane: 'actual',
    order: 4,
    label: 'Check client version distribution',
    status: 'neutral',
    day: 2,
  }),
  node({
    id: 'a5',
    lane: 'actual',
    order: 5,
    label: 'Ask customer to reinstall the client',
    status: 'unsupported',
    day: 3,
  }),
  node({
    id: 'f1',
    lane: 'actual',
    order: 6,
    kind: 'fork',
    label: 'Reinstall chosen before checking the proxy',
    status: 'uncertain',
    day: 3,
  }),
  node({
    id: 'a6',
    lane: 'actual',
    order: 7,
    label: 'Wait for reinstall results',
    status: 'unsupported',
    day: 4,
  }),
  node({
    id: 'a7',
    lane: 'actual',
    order: 8,
    label: 'Request the same logs again',
    status: 'unsupported',
    day: 5,
  }),
  node({
    id: 'a8',
    lane: 'actual',
    order: 9,
    label: 'Escalate to the network team',
    status: 'neutral',
    day: 6,
  }),
  node({
    id: 'a9',
    lane: 'actual',
    order: 10,
    label: 'Network team reviews the proxy configuration',
    status: 'productive',
    day: 7,
  }),
  node({
    id: 'a10',
    lane: 'actual',
    order: 11,
    label: 'Request a client trace',
    status: 'productive',
    day: 7,
  }),
  node({
    id: 'a11',
    lane: 'actual',
    order: 12,
    label: 'Apply the PAC file correction',
    status: 'productive',
    day: 8,
  }),
  node({
    id: 'a12',
    lane: 'actual',
    order: 13,
    label: 'Confirm with the customer',
    status: 'productive',
    day: 9,
  }),
  node({
    id: 'a13',
    lane: 'actual',
    order: 14,
    label: 'Document the resolution',
    status: 'neutral',
    day: 9,
  }),

  node({
    id: 'c1',
    lane: 'counterfactual',
    order: 7,
    label: 'Capture a proxy trace for one affected user',
    status: 'productive',
  }),
  node({
    id: 'c2',
    lane: 'counterfactual',
    order: 8,
    label: 'Compare proxy authentication settings',
    status: 'productive',
  }),
  node({
    id: 'c3',
    lane: 'counterfactual',
    order: 9,
    label: 'Spot the PAC file change',
    status: 'productive',
  }),
  node({
    id: 'c4',
    lane: 'counterfactual',
    order: 10,
    label: 'Correct the PAC file',
    status: 'productive',
  }),
  node({
    id: 'c5',
    lane: 'counterfactual',
    order: 11,
    label: 'Verify the sign-in success rate',
    status: 'uncertain',
  }),
  node({
    id: 'c6',
    lane: 'counterfactual',
    order: 12,
    label: 'Confirm with the customer',
    status: 'productive',
  }),

  node({
    id: 'o1',
    lane: 'outcome',
    order: 15,
    label: 'Resolved after 9 days',
    status: 'neutral',
    day: 9,
  }),
  node({
    id: 'o2',
    lane: 'outcome',
    order: 13,
    label: 'Simulated: resolved after 3 days',
    status: 'productive',
    simulated: true,
  }),

  node({
    id: 's1',
    lane: 'skill',
    order: 16,
    label: 'Check proxy authentication before a client reinstall',
    status: 'productive',
    confidence: 0.71,
  }),
];

const EDGES: GraphEdge[] = [
  edge('p1', 'a1', 'actual'),
  edge('a1', 'a2', 'actual'),
  edge('a2', 'a3', 'actual'),
  edge('a3', 'a4', 'actual'),
  edge('a4', 'a5', 'actual'),
  edge('a5', 'f1', 'actual'),
  edge('f1', 'a6', 'actual'),
  edge('a6', 'a7', 'actual'),
  edge('a7', 'a8', 'actual'),
  edge('a8', 'a9', 'actual'),
  edge('a9', 'a10', 'actual'),
  edge('a10', 'a11', 'actual'),
  edge('a11', 'a12', 'actual'),
  edge('a12', 'a13', 'actual'),
  edge('a13', 'o1', 'actual'),

  edge('a1', 'e3', 'informs'),
  edge('a2', 'e2', 'informs'),
  edge('a4', 'e4', 'informs'),
  edge('a6', 'e5', 'informs'),
  edge('a9', 'e6', 'informs'),
  edge('a10', 'e10', 'informs'),

  edge('e3', 'h1', 'supports', { strength: 0.7 }),
  edge('e4', 'h1', 'supports', { strength: 0.5 }),
  edge('e2', 'h1', 'supports', { strength: 0.3 }),
  edge('e5', 'h3', 'contradicts', { strength: 0.8 }),
  edge('e6', 'h4', 'supports', { strength: 0.8 }),
  edge('e9', 'h4', 'contradicts', { strength: 0.4 }),
  edge('e10', 'h4', 'supports', { strength: 0.9 }),

  edge('f1', 'c1', 'branches'),
  edge('c1', 'c2', 'counterfactual'),
  edge('c2', 'c3', 'counterfactual'),
  edge('c3', 'c4', 'counterfactual'),
  edge('c4', 'c5', 'counterfactual'),
  edge('c5', 'c6', 'counterfactual'),
  edge('c6', 'o2', 'counterfactual'),
  edge('o2', 's1', 'extracts'),
];

/** About forty nodes: an actual path with a decision fork, a simulated branch from that fork, and the extracted skill. */
export const SAMPLE_GRAPH: InvestigationGraph = {
  caseId: 'design-lab-sample',
  scenarioId: 'design-lab-scenario',
  asOf: null,
  generatedAt: '2025-03-14T09:00:00Z',
  nodes: NODES,
  edges: EDGES,
  lanes: GRAPH_LANES.map((id) => ({ id, label: id })),
  summary:
    'A sample support investigation. The actual path asks for a client reinstall before checking the proxy, then escalates and resolves after nine days. The simulated path branches at that decision, captures a proxy trace first and resolves in about three days. A skill is extracted from the simulated path.',
  truncated: false,
  nodeLimit: 160,
};
