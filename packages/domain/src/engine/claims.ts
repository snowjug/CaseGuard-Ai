import {
  ENGINEER_SIDE_ROLES,
  type Claim,
  type ClaimFlag,
  type CaseEvent,
  type Evidence,
  type EvidenceCategory,
  type ExtractionMethod,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { round } from '../util/math';
import { compareIso } from '../util/time';
import { type Belief, type BeliefTimeline, topHypotheses } from './belief';
import { type EngineContext, isCustomerSide, metaOf } from './context';
import type { RequirementState } from './requirements';
import { isSatisfiedAt } from './requirements';
import type { Observation } from './signals';
import type { TemporalView } from './temporal';

export interface AnchorInfo {
  eventIndex: number;
  eventId: string;
  timestamp: string;
  hypothesisId: string;
  /** Posterior of the anchored hypothesis immediately BEFORE the statement/action. */
  pBefore: number;
  leaderId: string;
  leaderP: number;
  contradictingEvidenceIds: string[];
  supportingEvidenceIds: string[];
}

export interface ClaimsInput {
  view: TemporalView;
  pack: CompiledPack;
  ctx: EngineContext;
  observations: readonly Observation[];
  evidence: readonly Evidence[];
  timeline: BeliefTimeline;
  requirementStates: readonly RequirementState[];
}

export interface ClaimsOutput {
  claims: Claim[];
  anchors: AnchorInfo[];
  /** Bounded, human-readable notes about limits that shortened the output (empty when none did). */
  notes: string[];
}

/**
 * Statement claims kept per event and per case. A body is one sentence per few characters, so without
 * a limit a few megabytes of "Likely." would become hundreds of thousands of claims. Selection is
 * deterministic: strongest signal first (definitive or root-cause statements, then checklist
 * phrasing, then hedged ones), then earliest; whatever is left out is counted in `notes`.
 */
export const MAX_STATEMENT_CLAIMS_PER_EVENT = 12;
export const MAX_STATEMENT_CLAIMS_PER_CASE = 1500;

const ENGINEER_STATEMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'case_note',
  'engineer_email',
  'escalation',
  'escalation_response',
  'resolution_note',
  'validation_result',
  'engineer_action',
]);

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const BELIEF_EVENT_TYPES: ReadonlySet<string> = new Set([
  'case_note',
  'engineer_email',
  'escalation',
]);

export function posteriorBefore(timeline: BeliefTimeline, eventIndex: number): Belief {
  return eventIndex <= 0
    ? timeline.prior
    : (timeline.steps[eventIndex - 1]?.posterior ?? timeline.prior);
}

export function leaderOf(belief: Belief): { id: string; p: number } {
  const top = topHypotheses(belief, 1)[0];
  return top ? { id: top.id, p: top.p } : { id: 'hyp.other', p: 0 };
}

/** Counts keyword hits at word starts; short keywords must also end at a word boundary. */
const keywordHits = (lowerText: string, pattern: RegExp): number =>
  lowerText.match(pattern)?.length ?? 0;

/** Hypothesis an engineer event is anchored on, from keyword hits in the text (null when none). */
export function statedHypothesis(text: string, pack: CompiledPack): string | null {
  const lower = text.toLowerCase();
  let best: { id: string; hits: number; prior: number } | null = null;
  for (const h of pack.pack.hypotheses) {
    const hits = (pack.keywordPatterns.get(h.id) ?? []).reduce(
      (sum, pattern) => sum + keywordHits(lower, pattern),
      0,
    );
    if (
      hits > 0 &&
      (best === null || hits > best.hits || (hits === best.hits && h.prior > best.prior))
    ) {
      best = { id: h.id, hits, prior: h.prior };
    }
  }
  return best?.id ?? null;
}

interface SentenceSpan {
  text: string;
  start: number;
}

const LABELLED_STATEMENT = /^(root cause|workaround|permanent fix|validation)\s*:/i;

interface StatementCandidate {
  span: SentenceSpan;
  spanIndex: number;
  hedged: boolean;
  definitive: boolean;
  template: boolean;
  rooted: boolean;
  /** 2 = definitive, root-cause or labelled statement; 1 = checklist phrasing; 0 = hedged only. */
  signal: 0 | 1 | 2;
}

/** Keeps `limit` candidates, strongest signal first and then earliest, returned in sentence order. */
function strongestFirst(items: readonly StatementCandidate[], limit: number): StatementCandidate[] {
  if (items.length <= limit) return [...items];
  return [...items]
    .sort((a, b) => b.signal - a.signal || a.spanIndex - b.spanIndex)
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.spanIndex - b.spanIndex);
}

export function sentencesOf(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9'"(])/);
    let cursor = 0;
    for (const part of parts) {
      const idx = line.indexOf(part, cursor);
      cursor = idx + part.length;
      const trimmed = part.trim();
      if (trimmed) out.push({ text: trimmed, start: lineStart + Math.max(0, idx) });
    }
  }
  return out;
}

/** The first lexicon cue found in the text, or null. */
function firstLexiconHit(regexes: readonly RegExp[], text: string): string | null {
  for (const re of regexes) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

export function evidenceEffectFor(
  timeline: BeliefTimeline,
  beforeIndex: number,
  hypothesisId: string,
): { supporting: { id: string; logLr: number }[]; contradicting: { id: string; logLr: number }[] } {
  const supporting: { id: string; logLr: number }[] = [];
  const contradicting: { id: string; logLr: number }[] = [];
  for (const step of timeline.steps) {
    if (step.eventIndex >= beforeIndex) break;
    for (const eff of step.effects) {
      const lr = eff.logLr[hypothesisId] ?? 0;
      if (lr >= 0.5) supporting.push({ id: eff.observation.id, logLr: lr });
      else if (lr <= -0.5) contradicting.push({ id: eff.observation.id, logLr: lr });
    }
  }
  supporting.sort((a, b) => b.logLr - a.logLr);
  contradicting.sort((a, b) => a.logLr - b.logLr);
  return { supporting, contradicting };
}

export function buildClaims(input: ClaimsInput): ClaimsOutput {
  const { view, pack, ctx, timeline, requirementStates } = input;
  const claims: Claim[] = [];
  const anchors: AnchorInfo[] = [];
  const hypName = (id: string): string => pack.hypotheses.get(id)?.name ?? id;
  const evidenceByObservation = new Map(input.evidence.map((e) => [e.id, e]));
  const eventById = new Map(view.events.map((e) => [e.id, e]));

  const base = (
    ruleId: string,
    key: string,
    fields: {
      text: string;
      category: EvidenceCategory;
      event: CaseEvent | null;
      timestamp: string;
      explanation: string;
      confidence: number;
      supporting?: string[];
      contradicting?: string[];
      related?: string[];
      flags?: ClaimFlag[];
      method?: ExtractionMethod;
      subject?: string | null;
      sourceStart?: number;
      sourceEnd?: number;
      excerpt?: string;
      missingEvidenceId?: string | null;
    },
  ): Claim => ({
    ...metaOf(ctx),
    id: stableId('clm', ctx.caseId, ruleId, key),
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    text: fields.text.slice(0, 1000),
    category: fields.category,
    aiCategory: fields.category,
    reviewedCategory: null,
    reviewState: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    subject: fields.subject ?? null,
    authorRole: fields.event?.participantRole ?? null,
    eventId: fields.event?.id ?? null,
    sourceRef: fields.event
      ? {
          eventId: fields.event.id,
          sourceId: fields.event.sourceId,
          pointer: `${fields.event.sourcePointer}/body`,
          ...(fields.sourceStart !== undefined ? { start: fields.sourceStart } : {}),
          ...(fields.sourceEnd !== undefined ? { end: fields.sourceEnd } : {}),
          excerpt: (fields.excerpt ?? fields.text).slice(0, 280),
        }
      : null,
    timestamp: fields.timestamp,
    supportingEvidenceIds: fields.supporting ?? [],
    contradictingEvidenceIds: fields.contradicting ?? [],
    relatedHypothesisIds: fields.related ?? [],
    confidence: round(fields.confidence, 2),
    explanation: fields.explanation.slice(0, 800),
    ruleId,
    flags: fields.flags ?? [],
    method: fields.method ?? 'rule',
    missingEvidenceId: fields.missingEvidenceId ?? null,
    simulated: false,
  });

  // 1) Claims backed directly by detected evidence -------------------------------------------
  const effectByObservation = new Map<string, Record<string, number>>();
  for (const step of timeline.steps)
    for (const eff of step.effects) effectByObservation.set(eff.observation.id, eff.logLr);
  for (const ev of input.evidence) {
    const event = eventById.get(ev.eventId) ?? null;
    const logLr = effectByObservation.get(ev.id) ?? {};
    const related = Object.entries(logLr)
      .filter(([, v]) => Math.abs(v) >= 0.75)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([id]) => id);
    const signal = pack.signals.get(ev.signalId);
    claims.push(
      base(`evidence.${ev.signalId}`, ev.id, {
        text: ev.label,
        category: ev.category,
        event,
        timestamp: ev.observedAt,
        explanation: `${signal?.explanation ?? ev.summary} Source text: “${ev.excerpt}”`,
        confidence: ev.confidence,
        supporting: [ev.id],
        related,
        method: ev.method === 'structured' ? 'structured' : 'pattern',
        ...(ev.sourceRef.start !== undefined ? { sourceStart: ev.sourceRef.start } : {}),
        ...(ev.sourceRef.end !== undefined ? { sourceEnd: ev.sourceRef.end } : {}),
        excerpt: ev.excerpt,
      }),
    );
  }

  // 2) Engineer statements: assumptions, facts, unsupported conclusions ----------------------
  const rootCausePattern = pack.claimPatterns.find((c) => c.subject === 'root_cause');
  const cue = {
    hedge: (text: string): boolean => pack.lexiconAny.hedges?.test(text) ?? false,
    definitive: (text: string): boolean => pack.lexiconAny.definitive?.test(text) ?? false,
    template: (text: string): boolean => pack.lexiconAny.template?.test(text) ?? false,
  };
  const limits = { eventsOverLimit: 0, droppedByEvent: 0, droppedByCase: 0, kept: 0 };
  view.events.forEach((event, index) => {
    if (!ENGINEER_SIDE_ROLES.includes(event.participantRole)) return;
    if (!ENGINEER_STATEMENT_EVENT_TYPES.has(event.type)) return;
    const before = posteriorBefore(timeline, index);
    const leader = leaderOf(before);
    const spans = sentencesOf(event.body);

    // One cheap pass classifies every sentence; only the strongest few become claims (see below).
    const definitiveCues = spans.map((s) => cue.definitive(s.text));
    const beliefSentences: string[] = [];
    const candidates: StatementCandidate[] = [];
    spans.forEach((span, spanIndex) => {
      const text = span.text;
      const definitiveCue = definitiveCues[spanIndex] ?? false;
      const hedged = cue.hedge(text);
      const rooted = rootCausePattern?.regex.test(text) ?? false;
      if (hedged || definitiveCue || rooted) beliefSentences.push(text);
      if (text.length < 25 && definitiveCue) return; // handled as a modifier of the previous sentence below
      const next = spans[spanIndex + 1];
      const followedByConfirmation =
        next !== undefined && next.text.length < 25 && (definitiveCues[spanIndex + 1] ?? false);
      const definitive = definitiveCue || followedByConfirmation;
      const template = cue.template(text);
      const labelled = LABELLED_STATEMENT.test(text);
      if (!hedged && !definitive && !template && !rooted && !labelled) return;
      candidates.push({
        span,
        spanIndex,
        hedged,
        definitive,
        template,
        rooted,
        signal: definitive || rooted || labelled ? 2 : template ? 1 : 0,
      });
    });
    // The working hypothesis comes only from sentences that express a belief, never from a request for data.
    const beliefText = beliefSentences.join(' ');
    const eventStated = beliefText ? statedHypothesis(beliefText, pack) : null;

    // Anchoring: the engineer's working hypothesis versus what the evidence already said.
    if (eventStated && eventStated !== 'hyp.other' && BELIEF_EVENT_TYPES.has(event.type)) {
      const pBefore = before[eventStated] ?? 0;
      if (pBefore < 0.15 && leader.p >= 0.4 && leader.id !== eventStated) {
        const effects = evidenceEffectFor(timeline, index, eventStated);
        anchors.push({
          eventIndex: index,
          eventId: event.id,
          timestamp: event.timestamp,
          hypothesisId: eventStated,
          pBefore,
          leaderId: leader.id,
          leaderP: leader.p,
          contradictingEvidenceIds: effects.contradicting.slice(0, 3).map((e) => e.id),
          supportingEvidenceIds: effects.supporting.slice(0, 3).map((e) => e.id),
        });
      }
    }

    const withinEventLimit = strongestFirst(candidates, MAX_STATEMENT_CLAIMS_PER_EVENT);
    if (withinEventLimit.length < candidates.length) limits.eventsOverLimit += 1;
    limits.droppedByEvent += candidates.length - withinEventLimit.length;
    const room = Math.max(0, MAX_STATEMENT_CLAIMS_PER_CASE - limits.kept);
    const selected =
      withinEventLimit.length <= room ? withinEventLimit : strongestFirst(withinEventLimit, room);
    limits.droppedByCase += withinEventLimit.length - selected.length;
    limits.kept += selected.length;

    const effectCache = new Map<string, ReturnType<typeof evidenceEffectFor>>();
    const effectsAt = (hypothesisId: string): ReturnType<typeof evidenceEffectFor> => {
      const cached = effectCache.get(hypothesisId);
      if (cached) return cached;
      const fresh = evidenceEffectFor(timeline, index, hypothesisId);
      effectCache.set(hypothesisId, fresh);
      return fresh;
    };

    for (const { span, hedged, definitive, template, rooted } of selected) {
      const text = span.text;
      const mentioned = statedHypothesis(text, pack) ?? eventStated;
      const pH = mentioned ? (before[mentioned] ?? 0) : null;
      const effects = mentioned ? effectsAt(mentioned) : { supporting: [], contradicting: [] };
      const supportIds = effects.supporting
        .filter((s) => evidenceByObservation.get(s.id)?.category === 'diagnostic_evidence')
        .slice(0, 3)
        .map((s) => s.id);
      const contradictedHere =
        mentioned !== null &&
        pH !== null &&
        pH < 0.15 &&
        leader.p >= 0.4 &&
        leader.id !== mentioned;
      const flags: ClaimFlag[] = [];
      let category: EvidenceCategory = 'engineer_assumption';
      let explanation: string;
      let confidence = 0.7;

      const validationRequirementId = pack.pack.policies.validationRequirementId;
      const validationOk = validationRequirementId
        ? isSatisfiedAt(
            requirementStates.find((s) => s.requirementId === validationRequirementId),
            index,
          )
        : false;
      if (event.type === 'validation_result' || event.type === 'resolution_note') {
        if (validationOk) {
          category = 'confirmed_fact';
          explanation =
            'Stated after a before/after validation (failures stopped following the change) was already on record, so this is backed by validation evidence.';
          confidence = 0.88;
        } else {
          flags.push('unvalidated_closure');
          explanation = 'Closure-style statement made before validation evidence was recorded.';
        }
      } else if (template && supportIds.length === 0) {
        flags.push('template_without_evidence');
        explanation =
          'Checklist or template phrasing stands in for evidence; no supporting diagnostic evidence is cited.';
      } else if (hedged && !definitive) {
        explanation = `Hedged language (“${firstLexiconHit(pack.lexicon.hedges, text) ?? 'likely'}”) marks this as an assumption, not an observation.`;
        confidence = 0.7;
      } else if (
        mentioned &&
        pH !== null &&
        pH >= pack.pack.policies.destructiveHypothesisThreshold &&
        supportIds.length > 0
      ) {
        category = 'confirmed_fact';
        explanation = `Stated as fact and backed by diagnostic evidence; the model estimate for “${hypName(mentioned)}” was ${pct(pH)} at that point.`;
        confidence = 0.85;
      } else {
        flags.push('assumption_as_fact');
        if (rooted || /root cause|the cause is|is the cause|caused by/i.test(text))
          flags.push('unsupported_root_cause');
        explanation = mentioned
          ? `Stated as established, but the model estimate for “${hypName(mentioned)}” was only ${pct(pH ?? 0)} and no supporting diagnostic evidence is cited, so it is treated as an assumption.`
          : 'Stated as established without supporting diagnostic evidence, so it is treated as an assumption.';
        confidence = 0.8;
      }
      if (contradictedHere) {
        flags.push('contradicted', 'ignored_contradiction');
        explanation += ` Evidence already on record favoured “${hypName(leader.id)}” (${pct(leader.p)}).`;
      }
      claims.push(
        base(`statement.${category}`, `${event.id}:${span.start}`, {
          text,
          category,
          event,
          timestamp: event.timestamp,
          explanation,
          confidence,
          supporting: category === 'confirmed_fact' ? supportIds : [],
          contradicting: contradictedHere ? effects.contradicting.slice(0, 3).map((e) => e.id) : [],
          related: mentioned ? [mentioned] : [],
          flags,
          sourceStart: span.start,
          sourceEnd: span.start + text.length,
          excerpt: text,
        }),
      );
    }
  });
  const notes: string[] = [];
  if (limits.droppedByEvent > 0) {
    notes.push(
      `Claim extraction keeps at most ${MAX_STATEMENT_CLAIMS_PER_EVENT} statement claims per event (strongest signals first, then earliest): ${limits.eventsOverLimit} event${limits.eventsOverLimit === 1 ? '' : 's'} had more qualifying sentences, and ${limits.droppedByEvent} sentence${limits.droppedByEvent === 1 ? ' was' : 's were'} not turned into claims.`,
    );
  }
  if (limits.droppedByCase > 0) {
    notes.push(
      `The case-wide limit of ${MAX_STATEMENT_CLAIMS_PER_CASE} statement claims was reached; ${limits.droppedByCase} further sentence${limits.droppedByCase === 1 ? '' : 's'} in later events ${limits.droppedByCase === 1 ? 'was' : 'were'} not turned into claims.`,
    );
  }

  // 3) Conflicts: engineer position versus the evidence on record ---------------------------
  for (const anchor of anchors) {
    const event = view.events[anchor.eventIndex] ?? null;
    claims.push(
      base('conflict.anchoring', anchor.eventId, {
        text: `Working hypothesis “${hypName(anchor.hypothesisId)}” (${pct(anchor.pBefore)} at this point) conflicts with evidence favouring “${hypName(anchor.leaderId)}” (${pct(anchor.leaderP)}).`,
        category: 'conflicting_evidence',
        event,
        timestamp: anchor.timestamp,
        explanation:
          'The case record already contained evidence that makes this hypothesis much less likely than the alternative, yet work continued on it. This is flagged as an ignored contradiction for review, not as a judgement of the person.',
        confidence: 0.8,
        supporting: anchor.supportingEvidenceIds,
        contradicting: anchor.contradictingEvidenceIds,
        related: [anchor.hypothesisId, anchor.leaderId],
        flags: ['ignored_contradiction'],
        method: 'derived',
      }),
    );
  }
  const bySubject = new Map<string, { value: string; claim: Claim }[]>();
  for (const event of view.events) {
    if (!isCustomerSide(event.participantRole)) continue;
    for (const pattern of pack.claimPatterns) {
      if (pattern.subject === 'root_cause') continue;
      if (pattern.roles && !pattern.roles.includes(event.participantRole)) continue;
      const match = pattern.regex.exec(event.body);
      const value = match?.[pattern.valueGroup]?.trim();
      if (!match || !value) continue;
      const claim = base(`attribute.${pattern.subject}`, `${event.id}:${value}`, {
        text: `${pattern.label}: ${value}`,
        category: 'customer_reported',
        event,
        timestamp: event.timestamp,
        explanation:
          'Value stated by the customer; kept as an attribute so contradicting statements can be detected.',
        confidence: 0.8,
        subject: pattern.subject,
        sourceStart: match.index,
        sourceEnd: match.index + match[0].length,
        excerpt: match[0],
      });
      claims.push(claim);
      const list = bySubject.get(pattern.subject) ?? [];
      list.push({ value, claim });
      bySubject.set(pattern.subject, list);
    }
  }
  for (const [subject, list] of bySubject) {
    const distinct = new Set(list.map((l) => l.value));
    if (distinct.size < 2) continue;
    const latest = list[list.length - 1];
    if (!latest) continue;
    const event = view.events.find((e) => e.id === latest.claim.eventId) ?? null;
    claims.push(
      base('conflict.subject', `${subject}:${[...distinct].join('|')}`, {
        text: `Conflicting statements about ${subject.replace(/_/g, ' ')}: ${[...distinct].join(' vs ')}.`,
        category: 'conflicting_evidence',
        event,
        timestamp: latest.claim.timestamp,
        explanation:
          'Different values were stated for the same attribute; confirm which is current before relying on either.',
        confidence: 0.7,
        subject,
        method: 'derived',
      }),
    );
  }

  // 4) AI inferences ------------------------------------------------------------------------
  for (const inference of pack.pack.inferences) {
    const obs = input.observations.find(
      (o) => o.signalId === inference.signalId && o.affectsBelief,
    );
    if (!obs) continue;
    const categorySet = pack.pack.hypotheses
      .filter((h) => inference.hypothesisCategories.includes(h.category))
      .map((h) => h.id);
    const event = view.events[obs.eventIndex] ?? null;
    const step = timeline.steps[obs.eventIndex];
    const mass = categorySet.reduce((s, id) => s + (step?.posterior[id] ?? 0), 0);
    claims.push(
      base(`inference.${inference.id.slice(4)}`, obs.id, {
        text: inference.text,
        category: 'ai_inference',
        event,
        timestamp: obs.timestamp,
        explanation: `${inference.explanation} The combined model estimate for the related hypotheses is ${pct(mass)}.`,
        confidence: Math.min(0.95, mass),
        supporting: [obs.id],
        related: categorySet,
        method: 'derived',
      }),
    );
  }
  let currentLeader: string | null = null;
  for (const step of timeline.steps) {
    const ranked = topHypotheses(step.posterior, 2);
    const top = ranked[0];
    const second = ranked[1];
    if (!top || top.p < 0.3 || top.p - (second?.p ?? 0) < 0.1 || top.id === currentLeader) continue;
    currentLeader = top.id;
    const event = view.events[step.eventIndex] ?? null;
    const effects = evidenceEffectFor(timeline, step.eventIndex + 1, top.id);
    claims.push(
      base('inference.leading-hypothesis', `${top.id}:${step.eventId}`, {
        text: `Leading hypothesis is now “${hypName(top.id)}”: ${pct(top.p)} model estimate (range ${pct(step.low[top.id] ?? top.p)}–${pct(step.high[top.id] ?? top.p)}).`,
        category: 'ai_inference',
        event,
        timestamp: step.at,
        explanation:
          'Computed from the evidence available at this moment using the knowledge pack likelihoods. It is a model estimate, not a statistical fact, and it can change as evidence arrives.',
        confidence: top.p,
        supporting: effects.supporting.slice(0, 4).map((s) => s.id),
        contradicting: [],
        related: [top.id],
        method: 'derived',
      }),
    );
  }

  // 5) Missing evidence ---------------------------------------------------------------------
  for (const state of requirementStates) {
    if (state.firstRelevantAt === null || state.firstRelevantIndex === null) continue;
    if (state.satisfiedAtIndex !== null && state.satisfiedAtIndex <= state.firstRelevantIndex)
      continue;
    const req = pack.requirements.get(state.requirementId);
    if (!req || req.criticality === 'helpful') continue;
    claims.push(
      base('missing.requirement', state.requirementId, {
        text: `Missing evidence: ${req.label}`,
        category: 'missing_evidence',
        event: null,
        timestamp: state.firstRelevantAt,
        explanation: `${req.description} Suggested ask: ${req.askText}`,
        confidence: 0.9,
        related: [],
        method: 'rule',
        missingEvidenceId: stableId('mis', ctx.caseId, state.requirementId),
      }),
    );
  }

  claims.sort((a, b) => {
    const byTime = compareIso(a.timestamp, b.timestamp);
    return byTime < 0 ? -1 : byTime > 0 ? 1 : a.id < b.id ? -1 : 1;
  });
  return { claims, anchors, notes };
}
