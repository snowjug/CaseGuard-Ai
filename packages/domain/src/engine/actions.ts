import {
  ENGINEER_SIDE_ROLES,
  type ActionValueBreakdown,
  type ActionValueConfig,
  type CaseEvent,
  type DiagnosticAction,
  type EffortLevel,
  type KnowledgeAction,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { hypothesisRecordId, stableId } from '../util/ids';
import { clamp, round, tokenJaccard } from '../util/math';
import { minutesBetween } from '../util/time';
import { toBreakdowns } from './action-value';
import type { BeliefTimeline } from './belief';
import { statedHypothesis } from './claims';
import { type EngineContext, metaOf } from './context';
import { eventText, firstDetectorMatch } from './signals';
import { analyzeView, PrefixAnalyzer, type ViewAnalysis } from './state';
import { createTemporalViewBeforeEvent, type TemporalView } from './temporal';

export interface DecisionRanking {
  eventId: string;
  eventIndex: number;
  timestamp: string;
  analysis: ViewAnalysis;
  candidates: ActionValueBreakdown[];
  blocked: ActionValueBreakdown[];
  /** Breakdown of the action actually taken (when it maps to a pack action). */
  actual: ActionValueBreakdown | null;
  best: ActionValueBreakdown | null;
  /** actual score / best score for diagnostic or enabling actions; null otherwise. */
  relative: number | null;
}

export interface ActionsInput {
  /** Full (post-hoc) view: decisions are evaluated on strictly earlier sub-views. */
  view: TemporalView;
  pack: CompiledPack;
  ctx: EngineContext;
  config: ActionValueConfig;
  timeline: BeliefTimeline;
  /** Shared prefix analyzer; created on demand when omitted. */
  analyzer?: PrefixAnalyzer;
}

export interface ActionsOutput {
  actions: DiagnosticAction[];
  decisions: Map<string, DecisionRanking>;
}

const ACTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'engineer_action',
  'engineer_email',
  'escalation',
]);
const REPEAT_CUE = /\b(re-?ran|again|repeat(ed)?|same (query|request)|once more)\b/i;
const MAX_ENGINEER_DIAGNOSTIC_CLASSES: ReadonlySet<string> = new Set(['diagnostic', 'enabling']);

/** Normalised cost (weighted time, tokens, customer effort, risk) below which a step is never "wasteful". */
export const MIN_MEANINGFUL_COST = 0.05;

/**
 * Prerequisite and hygiene steps (data requests, status updates, validation) are standard practice at
 * modest customer effort, so they are only flagged when repeated or when the effort is heavy.
 */
export function isHygieneAction(
  action: KnowledgeAction | undefined,
  config: ActionValueConfig,
): boolean {
  if (!action) return false;
  const hygiene =
    action.valueClass === 'enabling' ||
    action.valueClass === 'communication' ||
    action.valueClass === 'validation';
  return hygiene && config.effortScale[action.customerEffort] <= config.effortScale.medium;
}

export const actionCostOf = (
  breakdown: ActionValueBreakdown | null,
  config: ActionValueConfig,
): number => (breakdown ? Math.max(0, breakdown.denominator - config.epsilon) : 0);

/** Maps an event to a pack action key: explicit key first, then detectors on engineer-side text. */
export function resolveActionKey(event: CaseEvent, pack: CompiledPack): string | null {
  if (event.action?.actionKey && pack.actions.has(event.action.actionKey))
    return event.action.actionKey;
  if (!ENGINEER_SIDE_ROLES.includes(event.participantRole)) return null;
  if (!ACTION_EVENT_TYPES.has(event.type)) return null;
  const text = eventText(event);
  for (const action of pack.pack.actions) {
    if (firstDetectorMatch(pack.actionDetectors.get(action.id), event, text)) return action.id;
  }
  return null;
}

export function isActionEvent(event: CaseEvent, pack: CompiledPack): boolean {
  if (event.action !== null) return true;
  return resolveActionKey(event, pack) !== null;
}

/** Events that answer `eventId`, transitively (customer replies, tool output, summaries). */
export function responderClosure(events: readonly CaseEvent[], eventId: string): CaseEvent[] {
  const out: CaseEvent[] = [];
  const queue = [eventId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const e of events) {
      if (e.inResponseTo === current && !seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
        queue.push(e.id);
      }
    }
  }
  return out;
}

const informationClass = (bits: number): DiagnosticAction['informationGainClass'] =>
  bits >= 0.5 ? 'high' : bits >= 0.2 ? 'moderate' : bits >= 0.05 ? 'low' : 'none';

/**
 * Ranks the pack's candidate actions using ONLY what was known strictly before `event`
 * (the decision moment), and locates the action actually taken among them.
 */
export function rankAtEvent(
  events: readonly CaseEvent[],
  event: CaseEvent,
  eventIndex: number,
  pack: CompiledPack,
  ctx: EngineContext,
  config: ActionValueConfig,
  actionKey: string | null,
): DecisionRanking {
  const before = createTemporalViewBeforeEvent(events, event.id);
  return rankFromAnalysis(
    analyzeView(before, pack, ctx.caseId),
    event,
    eventIndex,
    pack,
    config,
    actionKey,
  );
}

/** Same as rankAtEvent but reuses an analyzer so long cases do not rescan their text per decision. */
export function rankAtIndex(
  analyzer: PrefixAnalyzer,
  event: CaseEvent,
  eventIndex: number,
  pack: CompiledPack,
  config: ActionValueConfig,
  actionKey: string | null,
): DecisionRanking {
  return rankFromAnalysis(analyzer.at(eventIndex), event, eventIndex, pack, config, actionKey);
}

function rankFromAnalysis(
  analysis: ViewAnalysis,
  event: CaseEvent,
  eventIndex: number,
  pack: CompiledPack,
  config: ActionValueConfig,
  actionKey: string | null,
): DecisionRanking {
  const { candidates, blocked } = toBreakdowns(pack, config, analysis.rankingState);
  const packAction = actionKey ? pack.actions.get(actionKey) : undefined;
  const actual = actionKey
    ? ([...candidates, ...blocked].find((b) => b.actionKey === actionKey) ?? null)
    : null;
  const best = candidates[0] ?? null;
  const diagnosticClass = packAction
    ? MAX_ENGINEER_DIAGNOSTIC_CLASSES.has(packAction.valueClass)
    : false;
  const relative =
    diagnosticClass && actual && best && best.score > 0
      ? round(clamp(actual.score / best.score, 0, 1), 3)
      : null;
  return {
    eventId: event.id,
    eventIndex,
    timestamp: event.timestamp,
    analysis,
    candidates,
    blocked,
    actual,
    best,
    relative,
  };
}

export function buildDiagnosticActions(input: ActionsInput): ActionsOutput {
  const { view, pack, ctx, config, timeline } = input;
  const events = view.events;
  const analyzer = input.analyzer ?? new PrefixAnalyzer(view, pack, ctx.caseId);
  const stepIndexByEvent = new Map(events.map((e, i) => [e.id, i]));
  const decisions = new Map<string, DecisionRanking>();
  const actions: DiagnosticAction[] = [];
  const earlier: { id: string; key: string | null; text: string; at: string }[] = [];
  const effortScale = config.effortScale;

  events.forEach((event, eventIndex) => {
    if (!isActionEvent(event, pack)) return;
    const actionKey = resolveActionKey(event, pack);
    const packAction = actionKey ? pack.actions.get(actionKey) : undefined;
    const id = stableId('act', ctx.caseId, event.id);
    const text = eventText(event);

    const decision = rankAtIndex(analyzer, event, eventIndex, pack, config, actionKey);
    decisions.set(event.id, decision);
    const { relative, best, actual } = decision;
    const diagnosticClass = packAction
      ? MAX_ENGINEER_DIAGNOSTIC_CLASSES.has(packAction.valueClass)
      : false;

    const responders = responderClosure(events, event.id);
    const involved = [event, ...responders];
    const gain = involved.reduce((sum, e) => {
      const idx = stepIndexByEvent.get(e.id);
      return sum + (idx === undefined ? 0 : (timeline.steps[idx]?.gainBits ?? 0));
    }, 0);
    const tokens = involved.reduce(
      (sum, e) => sum + (e.ai ? e.ai.promptTokens + e.ai.completionTokens : 0),
      0,
    );

    const priorSame = earlier.filter((p) => p.key !== null && p.key === actionKey);
    const explicitRepeat = event.action?.repeatOf
      ? stableId('act', ctx.caseId, event.action.repeatOf)
      : null;
    const similar = priorSame
      .filter(
        (p) => minutesBetween(p.at, event.timestamp) <= pack.pack.policies.repeatWindowMinutes,
      )
      .find((p) => tokenJaccard(p.text, text) >= 0.5 || REPEAT_CUE.test(text));
    const repeatOfActionId = explicitRepeat ?? similar?.id ?? null;
    const alreadyKnown = (actual?.safety.blockedReasons ?? []).some((r) =>
      r.startsWith('Already known'),
    );

    const effort: EffortLevel =
      event.action?.customerEffort ?? packAction?.customerEffort ?? 'none';
    const destructive = event.action?.destructive === true || packAction?.destructive === true;
    const risk = clamp(Math.max(packAction?.operationalRisk ?? 0, destructive ? 0.6 : 0), 0, 1);
    const lowValueReasons: string[] = [];
    if (repeatOfActionId !== null)
      lowValueReasons.push('Repeat of an earlier diagnostic that had already been run.');
    if (alreadyKnown && repeatOfActionId === null) {
      lowValueReasons.push(
        'Its likely outcome was already known from evidence on record at that moment.',
      );
    }
    const lowRelative =
      relative !== null &&
      relative < pack.pack.policies.lowValueRelativeScore &&
      actionCostOf(actual, config) >= MIN_MEANINGFUL_COST &&
      !isHygieneAction(packAction, config);
    if (lowRelative) {
      lowValueReasons.push(
        `Scored ${Math.round((relative ?? 0) * 100)}% of the best safe action available at that moment (“${best?.label ?? 'n/a'}”).`,
      );
    }
    if (diagnosticClass && gain < pack.pack.policies.lowValueInformationGainBits) {
      lowValueReasons.push(`Retrospectively produced little information (${round(gain, 2)} bits).`);
    }
    const stated = statedHypothesis(text, pack);

    actions.push({
      ...metaOf(ctx),
      id,
      caseId: ctx.caseId,
      analysisRunId: ctx.runId,
      eventId: event.id,
      sequence: eventIndex,
      actionKey,
      label: event.action?.label ?? packAction?.label ?? event.title ?? 'Action',
      kind: packAction?.kind ?? 'analysis',
      executorRole: event.participantRole,
      startedAt: event.timestamp,
      durationMinutes: event.action?.durationMinutes ?? packAction?.timeMinutes.typical ?? 15,
      customerEffort: effort,
      customerEffortScore: effortScale[effort],
      operationalRisk: round(risk, 3),
      destructive,
      tokenEstimate: tokens,
      computeUnits: packAction?.computeUnits ?? 0,
      targetHypothesisIds: (packAction?.targets ?? []).map((t) =>
        hypothesisRecordId(ctx.caseId, t),
      ),
      statedHypothesisId:
        stated && stated !== 'hyp.other' ? hypothesisRecordId(ctx.caseId, stated) : null,
      realizedInformationGainBits: round(gain, 3),
      informationGainClass: informationClass(gain),
      repeatOfActionId,
      isRepeat: repeatOfActionId !== null,
      lowValue: repeatOfActionId !== null || alreadyKnown || lowRelative,
      lowValueReasons,
      relativeValueAtDecision: relative,
    });
    earlier.push({ id, key: actionKey, text, at: event.timestamp });
  });

  return { actions, decisions };
}
