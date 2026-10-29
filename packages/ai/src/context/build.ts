import type { CaseEvent, Claim, Evidence } from '@caseguard/schemas';
import type { CompiledPack } from '@caseguard/domain';
import { AGENT_CATALOG, type KnowledgeSection } from '../agents/catalog';
import type { AgentTask } from '../agents/tasks';
import type { InjectionScanner, Redactor } from '../types';
import { hashJson } from '../util/hash';
import {
  clip,
  collapseWhitespace,
  contentWords,
  estimateTokens,
  jaccard,
  normalizeText,
} from '../util/text';
import { buildFocus } from './focus';
import { scopeAnalysis, type ScopedAnalysis } from './scope';
import type {
  AgentContext,
  BuiltContext,
  ContextClaim,
  ContextEvent,
  ContextEvidence,
  ContextIndex,
  ContextInjectionFinding,
  ContextKnowledge,
  EventStamp,
  TemporalMode,
  TrimLevel,
} from './types';

export interface ContextDeps {
  redact: Redactor;
  scanInjection: InjectionScanner;
  maxAnalysisDepth: number;
}

/** Characters of body text kept per event at each trim level (spec 5.14: context compression). */
const EVENT_TEXT_LIMIT: Record<TrimLevel, number> = { 0: 600, 1: 300, 2: 200, 3: 0, 4: 0 };
const EXCERPT_LIMIT: Record<TrimLevel, number> = { 0: 200, 1: 120, 2: 0, 3: 0, 4: 0 };
const SUMMARY_LIMIT: Record<TrimLevel, number> = { 0: 240, 1: 240, 2: 200, 3: 160, 4: 0 };
const CLAIM_LIMIT: Record<TrimLevel, number> = { 0: 300, 1: 240, 2: 200, 3: 160, 4: 120 };

const DUPLICATE_WINDOW = 30;
const DUPLICATE_MIN_CHARS = 80;
const DUPLICATE_SIMILARITY = 0.92;

interface PreparedEvent {
  event: CaseEvent;
  /** Redacted, whitespace-collapsed body (full length). */
  body: string;
  title: string | null;
  gapMinutes: number | null;
  duplicateOf: string | null;
}

function prepareEvents(events: readonly CaseEvent[], redact: Redactor): PreparedEvent[] {
  const kept: { id: string; norm: string; words: Set<string> }[] = [];
  const out: PreparedEvent[] = [];
  let previous: CaseEvent | undefined;
  for (const event of events) {
    const body = collapseWhitespace(redact(event.body));
    const title = event.title === null ? null : collapseWhitespace(redact(event.title));
    const norm = normalizeText(body);
    const words = new Set(contentWords(body));
    let duplicateOf: string | null = null;
    if (norm.length >= DUPLICATE_MIN_CHARS) {
      for (const candidate of kept.slice(-DUPLICATE_WINDOW)) {
        if (candidate.norm === norm || jaccard(words, candidate.words) >= DUPLICATE_SIMILARITY) {
          duplicateOf = candidate.id;
          break;
        }
      }
    }
    if (duplicateOf === null) kept.push({ id: event.id, norm, words });
    const gap = previous
      ? Math.max(
          0,
          Math.round((Date.parse(event.timestamp) - Date.parse(previous.timestamp)) / 60_000),
        )
      : null;
    out.push({ event, body, title, gapMinutes: gap, duplicateOf });
    previous = event;
  }
  return out;
}

function knowledgeFor(
  pack: CompiledPack,
  sections: readonly KnowledgeSection[],
): ContextKnowledge | null {
  if (sections.length === 0) return null;
  const p = pack.pack;
  return {
    packId: p.id,
    packVersion: p.version,
    hypotheses: sections.includes('hypotheses')
      ? p.hypotheses.map((h) => ({ id: h.id, name: h.name, description: clip(h.description, 240) }))
      : [],
    actions: sections.includes('actions')
      ? p.actions.map((a) => ({
          id: a.id,
          label: a.label,
          kind: a.kind,
          executor: a.executor,
          valueClass: a.valueClass,
          customerEffort: a.customerEffort,
          operationalRisk: a.operationalRisk,
          destructive: a.destructive,
          requiresApproval: a.requiresApproval,
        }))
      : [],
    requirements: sections.includes('requirements')
      ? p.requirements.map((r) => ({ id: r.id, label: r.label, criticality: r.criticality }))
      : [],
    signals: sections.includes('signals')
      ? p.signals.map((s) => ({ id: s.id, label: s.label }))
      : [],
  };
}

function selectEvents(
  prepared: readonly PreparedEvent[],
  scoped: ScopedAnalysis,
  level: TrimLevel,
): PreparedEvent[] {
  if (level <= 1) return [...prepared];
  const referenced = new Set<string>([
    ...scoped.evidence.map((e) => e.eventId),
    ...scoped.claims.flatMap((c) => (c.eventId ? [c.eventId] : [])),
  ]);
  if (level <= 3) {
    for (const a of scoped.actions) referenced.add(a.eventId);
    for (const f of scoped.forks) referenced.add(f.eventId);
  }
  const tail = prepared.slice(-2).map((p) => p.event.id);
  const head = prepared.slice(0, 1).map((p) => p.event.id);
  const keep = new Set([...referenced, ...tail, ...(level <= 3 ? head : [])]);
  return prepared.filter((p) => keep.has(p.event.id));
}

function projectEvidence(
  evidence: readonly Evidence[],
  level: TrimLevel,
  redact: Redactor,
): ContextEvidence[] {
  return evidence
    .filter((e) => level < 4 || e.strength !== 'weak')
    .map((e) => ({
      id: e.id,
      eventId: e.eventId,
      at: e.observedAt,
      label: e.label,
      summary: clip(e.summary, SUMMARY_LIMIT[level]),
      kind: e.kind,
      strength: e.strength,
      excerpt:
        EXCERPT_LIMIT[level] > 0
          ? clip(collapseWhitespace(redact(e.excerpt)), EXCERPT_LIMIT[level])
          : null,
    }));
}

function projectClaims(
  claims: readonly Claim[],
  includeFlags: boolean,
  level: TrimLevel,
  redact: Redactor,
): ContextClaim[] {
  return claims.map((c) => ({
    id: c.id,
    eventId: c.eventId,
    at: c.timestamp,
    role: c.authorRole,
    text: clip(collapseWhitespace(redact(c.text)), CLAIM_LIMIT[level]),
    flags: includeFlags ? c.flags : [],
  }));
}

function buildIndex(
  events: readonly ContextEvent[],
  stamps: ReadonlyMap<string, EventStamp>,
  evidence: readonly ContextEvidence[],
  claims: readonly ContextClaim[],
  knowledge: ContextKnowledge | null,
  anchors: ReadonlyMap<string, EventStamp>,
  actionIds: ReadonlySet<string>,
): ContextIndex {
  const eventStamps = new Map<string, EventStamp>();
  for (const e of events) {
    const stamp = stamps.get(e.id);
    if (stamp) eventStamps.set(e.id, stamp);
  }
  return {
    events: eventStamps,
    anchors,
    evidence: new Map(evidence.map((e) => [e.id, { at: e.at, eventId: e.eventId }])),
    claims: new Map(claims.map((c) => [c.id, { at: c.at, eventId: c.eventId }])),
    hypotheses: new Set(knowledge?.hypotheses.map((h) => h.id) ?? []),
    actions: new Set([...(knowledge?.actions.map((a) => a.id) ?? []), ...actionIds]),
    requirements: new Set(knowledge?.requirements.map((r) => r.id) ?? []),
    signals: new Set(knowledge?.signals.map((s) => s.id) ?? []),
  };
}

function buildSourceText(
  events: readonly ContextEvent[],
  evidence: readonly ContextEvidence[],
  claims: readonly ContextClaim[],
): Map<string, string> {
  const byEvent = new Map<string, string[]>();
  const push = (eventId: string | null, text: string): void => {
    if (eventId === null) return;
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), text]);
  };
  const out = new Map<string, string>();
  for (const e of evidence) {
    const text = [e.label, e.summary, e.excerpt ?? ''].join(' ');
    out.set(e.id, text);
    push(e.eventId, text);
  }
  for (const c of claims) {
    out.set(c.id, c.text);
    push(c.eventId, c.text);
  }
  for (const e of events) {
    out.set(
      e.id,
      [e.title ?? '', e.text ?? '', e.action ?? '', ...(byEvent.get(e.id) ?? [])].join(' '),
    );
  }
  return out;
}

function scanEvents(
  prepared: readonly PreparedEvent[],
  scan: InjectionScanner,
): { findings: ContextInjectionFinding[]; flagged: Set<string> } {
  const findings: ContextInjectionFinding[] = [];
  const flagged = new Set<string>();
  for (const p of prepared) {
    const hits = scan([p.title ?? '', p.body].join('\n'));
    for (const hit of hits) findings.push({ ...hit, eventId: p.event.id });
    if (hits.length > 0) flagged.add(p.event.id);
  }
  return { findings, flagged };
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function finalize(
  context: AgentContext,
  stamps: ReadonlyMap<string, EventStamp>,
  anchors: ReadonlyMap<string, EventStamp>,
  actionIds: ReadonlySet<string>,
  injection: readonly ContextInjectionFinding[],
  stats: { omitted: number; duplicates: number; included: number },
): BuiltContext {
  const index = buildIndex(
    context.events,
    stamps,
    context.evidence,
    context.claims,
    context.knowledge,
    anchors,
    actionIds,
  );
  const sourceText = buildSourceText(context.events, context.evidence, context.claims);
  const knowledgeText = context.knowledge
    ? [
        context.knowledge.packId,
        context.knowledge.packVersion,
        ...context.knowledge.hypotheses.map((h) => `${h.name} ${h.description}`),
        ...context.knowledge.actions.map((a) => a.label),
        ...context.knowledge.requirements.map((r) => r.label),
        ...context.knowledge.signals.map((s) => s.label),
      ]
    : [];
  const idText = [
    ...index.events.keys(),
    ...index.anchors.keys(),
    ...index.evidence.keys(),
    ...index.claims.keys(),
    ...index.hypotheses,
    ...index.actions,
    ...index.requirements,
    ...index.signals,
  ];
  const allText = [
    ...sourceText.values(),
    ...knowledgeText,
    ...idText,
    JSON.stringify(context.focus),
  ]
    .join(' ')
    .toLowerCase();
  const tokens = estimateTokens(JSON.stringify(context));
  return {
    context,
    index,
    sourceText,
    allText,
    contextHash: hashJson(context),
    injection,
    stats: {
      level: context.trimming.level,
      tokensBefore: tokens,
      tokensAfter: tokens,
      eventsIncluded: stats.included,
      eventsOmitted: stats.omitted,
      duplicatesRemoved: stats.duplicates,
      injectionIndicators: injection.length,
    },
  };
}

/** Context for the two deterministic-only agents: no case data, only the decision subject. */
function buildStaticContext(
  task: Extract<AgentTask, { agent: 'token_governor' | 'safety_policy_validator' }>,
  level: TrimLevel,
): BuiltContext {
  const meta = AGENT_CATALOG[task.agent];
  const focus: Record<string, unknown> =
    task.agent === 'token_governor'
      ? {
          targetAgent: task.input.targetAgent,
          estimatedInputTokens: task.input.estimatedInputTokens,
        }
      : { candidateAgent: task.input.candidateAgent };
  const context: AgentContext = {
    schemaVersion: 1,
    agent: task.agent,
    boundary: {
      asOf: EPOCH,
      mode: 'at',
      temporalMode: meta.temporalMode,
      resolutionIncluded: false,
    },
    workload: 'n/a',
    events: [],
    evidence: [],
    claims: [],
    knowledge: null,
    focus,
    trimming: { level, eventsOmitted: 0, duplicatesRemoved: 0 },
  };
  return finalize(context, new Map(), new Map(), new Set(), [], {
    omitted: 0,
    duplicates: 0,
    included: 0,
  });
}

/**
 * Builds the minimised, redacted, bounded context a model is allowed to see, restricted to the
 * task's temporal view. Pure and deterministic: identical visible inputs give an identical hash.
 */
export function buildContext(task: AgentTask, level: TrimLevel, deps: ContextDeps): BuiltContext {
  if (task.agent === 'token_governor' || task.agent === 'safety_policy_validator') {
    return buildStaticContext(task, level);
  }
  const meta = AGENT_CATALOG[task.agent];
  const input = task.input;
  const scoped = scopeAnalysis(input);
  const view = input.view;
  const temporalMode: TemporalMode = meta.temporalMode;

  const prepared = prepareEvents(view.events, deps.redact);
  const { findings, flagged } = scanEvents(prepared, deps.scanInjection);
  const selected = selectEvents(prepared, scoped, level);
  const actionByEvent = new Map(scoped.actions.map((a) => [a.eventId, a.label]));

  const events: ContextEvent[] = selected.map((p) => ({
    id: p.event.id,
    at: p.event.timestamp,
    type: p.event.type,
    role: p.event.participantRole,
    title: p.title === null ? null : clip(p.title, 160),
    text:
      p.duplicateOf !== null || EVENT_TEXT_LIMIT[level] === 0
        ? null
        : clip(p.body, EVENT_TEXT_LIMIT[level]),
    gapMinutes: p.gapMinutes,
    action: p.duplicateOf === null ? clip(actionByEvent.get(p.event.id) ?? '', 160) || null : null,
    flags: flagged.has(p.event.id) ? ['possible_prompt_injection'] : [],
    duplicateOf: p.duplicateOf,
  }));
  const includedIds = new Set(events.map((e) => e.id));

  const claimsInput =
    task.agent === 'evidence_classifier' && task.input.claimIds
      ? scoped.claims.filter((c) => task.input.claimIds?.includes(c.id))
      : scoped.claims;
  const evidence = meta.sections.evidence
    ? projectEvidence(
        scoped.evidence.filter((e) => includedIds.has(e.eventId)),
        level,
        deps.redact,
      )
    : [];
  const claims =
    meta.sections.claims === 'none'
      ? []
      : projectClaims(
          claimsInput.filter((c) => c.eventId !== null && includedIds.has(c.eventId)),
          meta.sections.claims === 'flagged',
          level,
          deps.redact,
        );
  const knowledge = knowledgeFor(input.pack, meta.sections.knowledge);
  const { focus, anchors, actionIds } = buildFocus(task, scoped, deps);

  const context: AgentContext = {
    schemaVersion: 1,
    agent: task.agent,
    boundary: {
      asOf: view.asOf,
      mode: view.mode,
      temporalMode,
      resolutionIncluded: temporalMode === 'post_hoc' && view.resolution !== null,
    },
    workload: input.pack.pack.workload,
    events,
    evidence,
    claims,
    knowledge,
    focus,
    trimming: {
      level,
      eventsOmitted: prepared.length - events.length,
      duplicatesRemoved: events.filter((e) => e.duplicateOf !== null).length,
    },
  };
  return finalize(context, scoped.stamps, anchors, actionIds, findings, {
    omitted: prepared.length - events.length,
    duplicates: context.trimming.duplicatesRemoved,
    included: events.length,
  });
}
