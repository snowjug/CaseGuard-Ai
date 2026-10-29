import type {
  CaseEvent,
  CounterfactualScenario,
  DecisionFork,
  DiagnosticAction,
  GraphEdge,
  GraphLane,
  GraphNode,
  InvestigationGraph,
} from '@caseguard/schemas';
import { round } from '../util/math';
import { compareIso, formatUtcStamp } from '../util/time';
import { informationClass } from './actions';
import { compareNullableIso, knownAt, lastStepAt } from './as-of';
import type { DeterministicAnalysis } from './pipeline';
import { ResponderIndex } from './responders';

export const GRAPH_NODE_LIMIT = 160;
const EVIDENCE_NODE_LIMIT = 18;
const HYPOTHESIS_NODE_LIMIT = 6;

export const GRAPH_LANE_LABELS: { id: GraphLane; label: string }[] = [
  { id: 'problem', label: 'Problem' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'hypothesis', label: 'Hypotheses' },
  { id: 'actual', label: 'Actual path' },
  { id: 'counterfactual', label: 'Counterfactual (simulated)' },
  { id: 'outcome', label: 'Outcome' },
  { id: 'skill', label: 'Skills' },
];

export interface GraphInput {
  caseTitle: string;
  caseId: string;
  events: readonly CaseEvent[];
  analysis: DeterministicAnalysis;
  asOf: string | null;
  now: string;
  scenario?: CounterfactualScenario | null;
  skills?: readonly { id: string; name: string; forkId: string | null; summary: string }[];
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function buildInvestigationGraph(input: GraphInput): InvestigationGraph {
  const { analysis, asOf, events, scenario } = input;
  const known = knownAt(asOf);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ids = new Set<string>();
  const addNode = (node: GraphNode): void => {
    if (ids.has(node.id)) return;
    ids.add(node.id);
    nodes.push(node);
  };
  const addEdge = (
    from: string,
    to: string,
    kind: GraphEdge['kind'],
    label: string | null,
    simulated: boolean,
    strength: number | null,
  ): void => {
    if (!ids.has(from) || !ids.has(to)) return;
    const id = `${kind}:${from}>${to}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({
      id: id.slice(0, 200),
      from,
      to,
      kind,
      label,
      simulated,
      strength: strength === null ? null : round(strength, 2),
    });
  };

  // problem ----------------------------------------------------------------------------------
  const problemId = 'problem:case';
  const firstEvent = events.find((e) => known(e.timestamp));
  addNode({
    id: problemId,
    kind: 'problem',
    lane: 'problem',
    label: clip(input.caseTitle, 120),
    detail: clip(firstEvent?.body.replace(/\s+/g, ' ') ?? '', 600),
    order: 0,
    timestamp: firstEvent?.timestamp ?? null,
    status: 'neutral',
    simulated: false,
    confidence: null,
    refs: firstEvent ? [{ type: 'event', id: firstEvent.id }] : [],
    textAlternative: `Problem: ${clip(input.caseTitle, 120)}.`,
  });

  // hypotheses (state at asOf) -------------------------------------------------------------
  // Confidence comes from the last step known at asOf (where a replay of the prefix ends); a recorded
  // point can lag it by a few skipped sub-1% moves, and its status never lags because every status
  // change is recorded.
  const lastVisibleStep = lastStepAt(analysis.timeline.steps, known);
  const hypothesisNodes = [...analysis.hypotheses]
    .map((h) => {
      const point = [...h.timeline].filter((p) => known(p.at)).pop();
      return {
        h,
        confidence: lastVisibleStep ? round(lastVisibleStep.posterior[h.key] ?? 0, 3) : h.prior,
        status: point?.status ?? 'active',
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, HYPOTHESIS_NODE_LIMIT);
  hypothesisNodes.forEach(({ h, confidence, status }, order) => {
    addNode({
      id: `hypothesis:${h.key}`,
      kind: 'hypothesis',
      lane: 'hypothesis',
      label: clip(h.name, 120),
      detail: clip(`${h.description} Model estimate: ${Math.round(confidence * 100)}%.`, 600),
      order,
      timestamp: null,
      status:
        status === 'leading' || status === 'confirmed'
          ? 'productive'
          : status === 'demoted' || status === 'ruled_out'
            ? 'unsupported'
            : 'uncertain',
      simulated: false,
      confidence,
      refs: [{ type: 'hypothesis', id: h.id }],
      textAlternative: `Hypothesis ${h.name}, ${status.replace('_', ' ')}, model estimate ${Math.round(confidence * 100)} percent.`,
    });
  });

  // evidence -----------------------------------------------------------------------------------
  const strongLinkByEvidence = new Map<
    string,
    { hypothesisKey: string; logLr: number; polarity: 'supports' | 'contradicts' }
  >();
  for (const link of analysis.links) {
    if (link.polarity === 'neutral') continue;
    const h = analysis.hypotheses.find((x) => x.id === link.hypothesisId);
    if (!h) continue;
    const current = strongLinkByEvidence.get(link.evidenceId);
    if (!current || Math.abs(link.logLikelihoodRatio) > Math.abs(current.logLr)) {
      strongLinkByEvidence.set(link.evidenceId, {
        hypothesisKey: h.key,
        logLr: link.logLikelihoodRatio,
        polarity: link.polarity,
      });
    }
  }
  const keyEvidence = analysis.evidence
    .filter(
      (e) =>
        known(e.observedAt) &&
        (strongLinkByEvidence.get(e.id)
          ? Math.abs(strongLinkByEvidence.get(e.id)?.logLr ?? 0) >= 0.75
          : false),
    )
    .sort((a, b) => (compareIso(a.observedAt, b.observedAt) < 0 ? -1 : 1))
    .slice(0, EVIDENCE_NODE_LIMIT);
  keyEvidence.forEach((e, order) => {
    const link = strongLinkByEvidence.get(e.id);
    addNode({
      id: `evidence:${e.id}`,
      kind: 'evidence',
      lane: 'evidence',
      label: clip(e.label, 120),
      detail: clip(`“${e.excerpt}”`, 600),
      order,
      timestamp: e.observedAt,
      status: e.category === 'diagnostic_evidence' ? 'productive' : 'uncertain',
      simulated: false,
      confidence: e.confidence,
      refs: [
        { type: 'evidence', id: e.id },
        { type: 'event', id: e.eventId },
      ],
      textAlternative: `Evidence at ${formatUtcStamp(e.observedAt)}: ${e.label}.`,
    });
    if (link)
      addEdge(
        `evidence:${e.id}`,
        `hypothesis:${link.hypothesisKey}`,
        link.polarity === 'supports' ? 'supports' : 'contradicts',
        null,
        false,
        Math.min(1, Math.abs(link.logLr) / 3),
      );
  });

  // actual path ----------------------------------------------------------------------------------
  const actions = analysis.actions.filter((a) => known(a.startedAt));
  let previousId: string = problemId;
  const forkByEvent = new Map(analysis.forks.map((f) => [f.eventId, f]));
  const responderIndex = new ResponderIndex(events);
  const gainByEvent = new Map(analysis.timeline.steps.map((s) => [s.eventId, s.gainBits]));
  /**
   * Information realised by an action and its answers. The stored value counts answers recorded
   * after `asOf`, which an as-of view must not reveal, so it is recomputed from the answers known by
   * then (exactly what a replay of the prefix would produce).
   */
  const realizedAsOf = (
    a: DiagnosticAction,
    responders: readonly CaseEvent[],
  ): Pick<DiagnosticAction, 'realizedInformationGainBits' | 'informationGainClass'> => {
    if (asOf === null) return a;
    const gain = [
      a.eventId,
      ...responders.filter((e) => known(e.timestamp)).map((e) => e.id),
    ].reduce((sum, eventId) => sum + (gainByEvent.get(eventId) ?? 0), 0);
    return {
      realizedInformationGainBits: round(gain, 3),
      informationGainClass: informationClass(gain),
    };
  };
  actions.forEach((a, order) => {
    const id = `action:${a.id}`;
    const responderEvents = responderIndex.closure(a.eventId);
    const realized = realizedAsOf(a, responderEvents);
    const status = actionStatus(a, asOf === null ? realized.informationGainClass : null);
    addNode({
      id,
      kind: 'action',
      lane: 'actual',
      label: clip(a.label, 120),
      detail: clip(
        `${formatUtcStamp(a.startedAt)} · ${a.customerEffort.replace('_', ' ')} customer effort · ${round(realized.realizedInformationGainBits, 2)} bits gained${a.isRepeat ? ' · repeat' : ''}`,
        600,
      ),
      order,
      timestamp: a.startedAt,
      status,
      simulated: false,
      confidence: a.relativeValueAtDecision,
      refs: [
        { type: 'action', id: a.id },
        { type: 'event', id: a.eventId },
      ],
      textAlternative: `Action at ${formatUtcStamp(a.startedAt)}: ${a.label}, ${status}.`,
    });
    addEdge(previousId, id, 'actual', null, false, null);
    previousId = id;
    const fork = forkByEvent.get(a.eventId);
    if (fork) addForkNode(fork, order);
    // Evidence produced by the responses to this action.
    const responders = new Set(responderEvents.map((e) => e.id));
    for (const e of keyEvidence)
      if (responders.has(e.eventId)) addEdge(id, `evidence:${e.id}`, 'informs', null, false, null);
  });

  function addForkNode(fork: DecisionFork, order: number): void {
    addNode({
      id: `fork:${fork.id}`,
      kind: 'fork',
      lane: 'actual',
      label: clip(fork.title, 120),
      detail: clip(fork.summary, 600),
      order,
      timestamp: fork.timestamp,
      status: fork.severity === 'high' ? 'unsupported' : 'uncertain',
      simulated: false,
      confidence: fork.impactScore,
      refs: [
        { type: 'fork', id: fork.id },
        { type: 'event', id: fork.eventId },
      ],
      textAlternative: `Decision fork at ${formatUtcStamp(fork.timestamp)}: ${fork.title}.`,
    });
    const actionNode = actions.find((x) => x.eventId === fork.eventId);
    if (actionNode)
      addEdge(
        `action:${actionNode.id}`,
        `fork:${fork.id}`,
        'branches',
        'decision point',
        false,
        fork.impactScore,
      );
  }

  // counterfactual path ---------------------------------------------------------------------------
  if (scenario) {
    let previousStep = `fork:${scenario.forkId}`;
    scenario.steps.forEach((s, order) => {
      const id = `step:${s.id}`;
      addNode({
        id,
        kind: 'counterfactual_step',
        lane: 'counterfactual',
        label: clip(s.label, 120),
        detail: clip(`Simulated: ${s.predictedOutcome.simulatedResult}`, 600),
        order,
        timestamp: s.simulatedAt,
        status: s.uncertainty === 'high' ? 'uncertain' : 'productive',
        simulated: true,
        confidence: s.predictedOutcome.probability,
        refs: [
          { type: 'step', id: s.id },
          { type: 'scenario', id: scenario.id },
        ],
        textAlternative: `Simulated step ${order + 1}: ${s.label}. Predicted outcome ${s.predictedOutcome.label}.`,
      });
      addEdge(
        previousStep,
        id,
        order === 0 ? 'branches' : 'counterfactual',
        order === 0 ? 'what if' : null,
        true,
        null,
      );
      previousStep = id;
    });
    const outcomeId = `outcome:sim:${scenario.id}`;
    const top = scenario.steps[scenario.steps.length - 1]?.posteriorAfter[0];
    addNode({
      id: outcomeId,
      kind: 'outcome',
      lane: 'outcome',
      label: 'Simulated diagnosis',
      detail: clip(scenario.summary, 600),
      order: 1,
      timestamp: scenario.steps[scenario.steps.length - 1]?.simulatedAt ?? null,
      status: 'uncertain',
      simulated: true,
      confidence: top?.confidence ?? null,
      refs: [{ type: 'scenario', id: scenario.id }],
      textAlternative:
        'Simulated outcome of the counterfactual path. This is an estimate, not a measurement.',
    });
    addEdge(previousStep, outcomeId, 'counterfactual', null, true, null);
  }

  // outcome (actual) --------------------------------------------------------------------------------
  const diagnosisHypothesis = hypothesisNodes.find(
    (x) => x.status === 'confirmed' || x.status === 'leading',
  );
  if (actions.length > 0 && diagnosisHypothesis) {
    const outcomeId = 'outcome:actual';
    addNode({
      id: outcomeId,
      kind: 'outcome',
      lane: 'outcome',
      label: clip(`Actual: ${diagnosisHypothesis.h.name}`, 120),
      detail: clip(
        `Leading hypothesis at the end of the record: ${Math.round(diagnosisHypothesis.confidence * 100)}% (model estimate).`,
        600,
      ),
      order: 0,
      timestamp: events.filter((e) => known(e.timestamp)).pop()?.timestamp ?? null,
      status: diagnosisHypothesis.status === 'confirmed' ? 'productive' : 'uncertain',
      simulated: false,
      confidence: diagnosisHypothesis.confidence,
      refs: [{ type: 'hypothesis', id: diagnosisHypothesis.h.id }],
      textAlternative: `Actual outcome: ${diagnosisHypothesis.h.name}.`,
    });
    addEdge(previousId, outcomeId, 'actual', null, false, null);
    addEdge(`hypothesis:${diagnosisHypothesis.h.key}`, outcomeId, 'informs', null, false, null);
  }

  // skills -----------------------------------------------------------------------------------------
  (input.skills ?? []).slice(0, 6).forEach((skill, order) => {
    addNode({
      id: `skill:${skill.id}`,
      kind: 'skill',
      lane: 'skill',
      label: clip(skill.name, 120),
      detail: clip(skill.summary, 600),
      order,
      timestamp: null,
      status: 'productive',
      simulated: false,
      confidence: null,
      refs: [{ type: 'skill', id: skill.id }],
      textAlternative: `Skill extracted: ${skill.name}.`,
    });
    if (skill.forkId)
      addEdge(`fork:${skill.forkId}`, `skill:${skill.id}`, 'extracts', 'extracts', false, null);
  });

  // normalise orders per lane so layout can rely on dense 0..n ordinals
  for (const lane of GRAPH_LANE_LABELS) {
    nodes
      .filter((n) => n.lane === lane.id)
      .sort((a, b) => a.order - b.order || compareNullableIso(a.timestamp, b.timestamp))
      .forEach((n, i) => {
        n.order = i;
      });
  }

  const truncated = nodes.length > GRAPH_NODE_LIMIT;
  const keptNodes = truncated ? nodes.slice(0, GRAPH_NODE_LIMIT) : nodes;
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)).slice(0, 400);

  const laneCounts = GRAPH_LANE_LABELS.map(
    (l) => `${keptNodes.filter((n) => n.lane === l.id).length} ${l.label.toLowerCase()}`,
  );
  return {
    caseId: input.caseId,
    scenarioId: scenario?.id ?? null,
    asOf,
    generatedAt: input.now,
    nodes: keptNodes,
    edges: keptEdges,
    lanes: GRAPH_LANE_LABELS,
    summary: clip(
      `Investigation graph with ${keptNodes.length} nodes and ${keptEdges.length} connections: ${laneCounts.join(', ')}. Counterfactual nodes are simulated estimates and are always labelled as such.`,
      2000,
    ),
    truncated,
    nodeLimit: GRAPH_NODE_LIMIT,
  };
}

/** Relative value at which a step counts as well chosen when only decision-time facts may be used. */
const WELL_CHOSEN_RELATIVE_VALUE = 0.6;

/**
 * Whole-record graphs may colour a step by the information it eventually produced (`realizedClass`,
 * retrospective). As-of graphs pass null and use only what was knowable when the step was taken.
 */
function actionStatus(
  a: DiagnosticAction,
  realizedClass: DiagnosticAction['informationGainClass'] | null,
): GraphNode['status'] {
  if (a.lowValue || a.isRepeat || a.destructive) return 'unsupported';
  if (realizedClass !== null)
    return realizedClass === 'high' || realizedClass === 'moderate' ? 'productive' : 'uncertain';
  return a.relativeValueAtDecision !== null &&
    a.relativeValueAtDecision >= WELL_CHOSEN_RELATIVE_VALUE
    ? 'productive'
    : 'uncertain';
}
