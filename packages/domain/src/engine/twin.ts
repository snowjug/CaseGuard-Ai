import {
  ENGINEER_SIDE_ROLES,
  TWIN_SECTIONS,
  type Case,
  type CaseEvent,
  type CaseParticipant,
  type CaseResolution,
  type DigitalTwin,
  type ExtractionMethod,
  type SourceRef,
  type TwinField,
  type TwinSection,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { stableId } from '../util/ids';
import { round } from '../util/math';
import { compareIso, formatDuration, formatUtcStamp, minutesBetween } from '../util/time';
import { knownAt } from './as-of';
import { isCustomerSide, type EngineContext } from './context';
import { sentencesOf } from './claims';
import type { DeterministicAnalysis } from './pipeline';
import { MAX_EXCERPT_CHARS } from './signals';
import { sourcePointerFor } from './source-ref';

export interface TwinInput {
  caseRecord: Pick<
    Case,
    'id' | 'title' | 'product' | 'workload' | 'severity' | 'status' | 'customerAlias' | 'openedAt'
  >;
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  ctx: EngineContext;
  /** Instant to view the twin at; null means the whole record. Nothing after it is exposed. */
  asOf: string | null;
}

const IMPACT_CUE =
  /\b(cannot|can't|unable|blocked|director|executive|customers?|revenue|agents?|calls?|deadline|urgent|losing)\b/i;
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const SITE_PHRASE =
  /\b(?:across|at|in|between)\s+(?:our\s+)?([A-Z][A-Za-z]+(?:\s+and\s+[A-Z][A-Za-z]+)*)\s+(?:branch(?:es)?|sites?|offices?)\b/;
const CLIENT_VERSION = /\bversion\s+(\d+(?:\.\d+){1,3})\b/i;

export function buildDigitalTwin(input: TwinInput): DigitalTwin {
  const { caseRecord, events, analysis, pack, ctx, asOf } = input;
  const isKnown = knownAt(asOf);
  const known = (iso: string | null): boolean => iso === null || isKnown(iso);
  const visible = events.filter((e) => known(e.timestamp));
  const visibleIds = new Set(visible.map((e) => e.id));
  const fields: TwinField[] = [];

  const refOf = (
    event: CaseEvent,
    excerpt?: string,
    /** Counted from the start of the event body; leave out when the excerpt is not one span of it. */
    span?: { start: number; end: number },
  ): SourceRef => ({
    eventId: event.id,
    sourceId: event.sourceId,
    pointer: sourcePointerFor(event, span ? 'body' : null),
    ...(span ? { field: 'body' as const, start: span.start, end: span.end } : {}),
    excerpt: (excerpt ?? event.body).slice(0, MAX_EXCERPT_CHARS),
  });
  const add = (
    section: TwinSection,
    key: string,
    label: string,
    value: TwinField['value'],
    display: string,
    refs: SourceRef[],
    confidence: number,
    method: ExtractionMethod,
    observedAt: string | null,
  ): void => {
    if (!known(observedAt)) return;
    fields.push({
      id: stableId('twf', ctx.caseId, section, key),
      section,
      label: label.slice(0, 160),
      value,
      display: display.slice(0, 1000),
      sourceRefs: refs.slice(0, 12),
      confidence: round(confidence, 2),
      method,
      extractedAt: ctx.now,
      reviewStatus: 'pending',
      observedAt,
    });
  };

  const firstCustomer = visible.find(
    (e) => isCustomerSide(e.participantRole) && e.body.trim().length > 0,
  );
  const opened = events[0]?.timestamp ?? caseRecord.openedAt;

  // problem_statement ------------------------------------------------------------------------
  if (firstCustomer) {
    const spans = sentencesOf(firstCustomer.body)
      .filter((s) => !/^(hello|hi|dear|thanks?|regards)\b/i.test(s.text))
      .slice(0, 3);
    const text = spans.map((s) => s.text).join(' ');
    if (text) {
      // Several sentences are joined into one statement, so they are one span of the body only when there is one.
      const only = spans.length === 1 ? spans[0] : undefined;
      add(
        'problem_statement',
        'initial-report',
        'Reported problem',
        text,
        text,
        [
          refOf(
            firstCustomer,
            text,
            only && { start: only.offset, end: only.offset + only.text.length },
          ),
        ],
        0.9,
        'rule',
        firstCustomer.timestamp,
      );
    }
  }
  add(
    'problem_statement',
    'title',
    'Case title',
    caseRecord.title,
    caseRecord.title,
    [],
    1,
    'structured',
    opened,
  );

  // customer_impact & scope -----------------------------------------------------------------
  const counts = analysis.claims.filter(
    (c) => c.subject === 'affected_user_count' && known(c.timestamp),
  );
  const latestCount = counts[counts.length - 1];
  if (latestCount) {
    add(
      'customer_impact',
      'affected-users',
      'Affected users (as reported)',
      latestCount.text,
      latestCount.text,
      latestCount.sourceRef ? [latestCount.sourceRef] : [],
      0.8,
      'pattern',
      latestCount.timestamp,
    );
    add(
      'scope',
      'affected-users',
      'Affected users',
      latestCount.text,
      latestCount.text,
      latestCount.sourceRef ? [latestCount.sourceRef] : [],
      0.8,
      'pattern',
      latestCount.timestamp,
    );
  }
  const impactSentences = new Map<string, { event: CaseEvent; text: string; offset: number }>();
  for (const event of visible) {
    if (!isCustomerSide(event.participantRole)) continue;
    for (const s of sentencesOf(event.body)) {
      if (IMPACT_CUE.test(s.text) && s.text.length >= 25 && !impactSentences.has(s.text)) {
        impactSentences.set(s.text, { event, text: s.text, offset: s.offset });
      }
    }
  }
  [...impactSentences.values()].slice(0, 4).forEach((s, i) => {
    add(
      'customer_impact',
      `impact-${i}`,
      'Business impact statement',
      s.text,
      s.text,
      [refOf(s.event, s.text, { start: s.offset, end: s.offset + s.text.length })],
      0.7,
      'rule',
      s.event.timestamp,
    );
  });
  add(
    'customer_impact',
    'severity',
    'Case severity',
    caseRecord.severity,
    `Severity ${caseRecord.severity}`,
    [],
    1,
    'structured',
    opened,
  );
  for (const claim of analysis.claims
    .filter((c) => c.subject === 'failure_start' && known(c.timestamp))
    .slice(0, 1)) {
    add(
      'scope',
      'failure-start',
      'Reported start of failures',
      claim.text,
      claim.text,
      claim.sourceRef ? [claim.sourceRef] : [],
      0.8,
      'pattern',
      claim.timestamp,
    );
  }

  // environment ---------------------------------------------------------------------------------
  add(
    'environment',
    'product',
    'Product',
    caseRecord.product,
    `${caseRecord.product} (${caseRecord.workload})`,
    [],
    1,
    'structured',
    opened,
  );
  add(
    'environment',
    'customer',
    'Customer',
    caseRecord.customerAlias,
    caseRecord.customerAlias,
    [],
    1,
    'structured',
    opened,
  );
  const sitePhrase = visible
    .map((e) => ({ e, m: SITE_PHRASE.exec(e.body) }))
    .find((x) => x.m !== null);
  if (sitePhrase?.m) {
    add(
      'environment',
      'sites',
      'Sites mentioned',
      sitePhrase.m[1] ?? '',
      `Affected sites: ${sitePhrase.m[1]}`,
      [
        refOf(sitePhrase.e, sitePhrase.m[0], {
          start: sitePhrase.m.index,
          end: sitePhrase.m.index + sitePhrase.m[0].length,
        }),
      ],
      0.75,
      'pattern',
      sitePhrase.e.timestamp,
    );
  }
  const addresses = new Map<string, CaseEvent>();
  for (const event of visible)
    for (const ip of event.body.match(IP_ADDRESS) ?? [])
      if (!addresses.has(ip)) addresses.set(ip, event);
  if (addresses.size > 0) {
    const first = [...addresses.values()][0];
    const latest = [...addresses.values()].reduce((a, b) =>
      compareIso(a.timestamp, b.timestamp) > 0 ? a : b,
    );
    add(
      'environment',
      'addresses',
      'Network addresses mentioned',
      [...addresses.keys()],
      `Addresses in the record: ${[...addresses.keys()].slice(0, 6).join(', ')}`,
      first ? [refOf(first)] : [],
      0.7,
      'pattern',
      latest.timestamp,
    );
  }
  const version = visible
    .map((e) => ({ e, m: CLIENT_VERSION.exec(e.body) }))
    .find((x) => x.m !== null);
  if (version?.m) {
    add(
      'environment',
      'client-version',
      'Client version',
      version.m[1] ?? '',
      `Client version ${version.m[1]}`,
      [
        refOf(version.e, version.m[0], {
          start: version.m.index,
          end: version.m.index + version.m[0].length,
        }),
      ],
      0.7,
      'pattern',
      version.e.timestamp,
    );
  }

  // observations (scope-tagged signals go to scope) ------------------------------------------
  for (const evidence of analysis.evidence) {
    if (!known(evidence.observedAt)) continue;
    const section = pack.signals.get(evidence.signalId)?.twinSection ?? 'observations';
    add(
      section,
      `evidence:${evidence.id}`,
      evidence.label,
      evidence.label,
      `${evidence.label}: “${evidence.excerpt}”`,
      [evidence.sourceRef],
      evidence.confidence,
      evidence.method === 'structured' ? 'structured' : 'pattern',
      evidence.observedAt,
    );
  }

  // actions & decisions ---------------------------------------------------------------------
  for (const action of analysis.actions) {
    if (!known(action.startedAt)) continue;
    const event = events.find((e) => e.id === action.eventId);
    add(
      'actions',
      `action:${action.id}`,
      action.label,
      action.actionKey ?? action.label,
      `${formatUtcStamp(action.startedAt)} — ${action.label} (${action.customerEffort.replace('_', ' ')} customer effort${action.isRepeat ? ', repeat' : ''})`,
      event ? [refOf(event)] : [],
      0.9,
      'structured',
      action.startedAt,
    );
  }
  for (const fork of analysis.forks) {
    if (!known(fork.timestamp)) continue;
    const event = events.find((e) => e.id === fork.eventId);
    add(
      'decisions',
      `fork:${fork.id}`,
      fork.title,
      fork.category,
      `${formatUtcStamp(fork.timestamp)} — ${fork.title}: ${fork.summary}`,
      event ? [refOf(event)] : [],
      1 - fork.uncertainty.score * 0.5,
      'derived',
      fork.timestamp,
    );
  }
  for (const claim of analysis.claims.filter(
    (c) => c.ruleId === 'inference.leading-hypothesis' && known(c.timestamp),
  )) {
    add(
      'decisions',
      `leader:${claim.id}`,
      'Leading hypothesis changed',
      claim.text,
      claim.text,
      claim.sourceRef ? [claim.sourceRef] : [],
      claim.confidence,
      'derived',
      claim.timestamp,
    );
  }

  // communications ----------------------------------------------------------------------------
  const engineerEmails = visible.filter((e) => e.type === 'engineer_email');
  const customerEmails = visible.filter((e) => e.type === 'customer_email');
  if (engineerEmails.length + customerEmails.length > 0) {
    let longest = 0;
    let longestEvent: CaseEvent | null = null;
    visible.forEach((event, i) => {
      const prev = visible[i - 1];
      if (
        !prev ||
        !isCustomerSide(prev.participantRole) ||
        !ENGINEER_SIDE_ROLES.includes(event.participantRole)
      )
        return;
      const gap = minutesBetween(prev.timestamp, event.timestamp);
      if (gap > longest) {
        longest = gap;
        longestEvent = event;
      }
    });
    const lastVisible = visible[visible.length - 1];
    add(
      'communications',
      'volume',
      'Message exchange',
      `${customerEmails.length} customer / ${engineerEmails.length} engineer emails`,
      `${customerEmails.length} customer emails and ${engineerEmails.length} engineer emails on record.`,
      [],
      1,
      'structured',
      lastVisible?.timestamp ?? null,
    );
    if (longestEvent && longest >= 120) {
      const ev: CaseEvent = longestEvent;
      add(
        'communications',
        'longest-wait',
        'Longest customer wait for a reply',
        round(longest, 0),
        `The customer waited ${formatDuration(longest)} for a reply before ${formatUtcStamp(ev.timestamp)}.`,
        [refOf(ev)],
        0.95,
        'derived',
        ev.timestamp,
      );
    }
    const expectation = engineerEmails.filter((e) =>
      pack.lexicon.expectation.some((re) => re.test(e.body)),
    );
    add(
      'communications',
      'expectation-setting',
      'Expectation setting',
      expectation.length,
      expectation.length > 0
        ? `${expectation.length} engineer message(s) set an expectation or ETA.`
        : 'No engineer message set an expectation or ETA.',
      expectation[0] ? [refOf(expectation[0])] : [],
      0.7,
      'rule',
      lastVisible?.timestamp ?? null,
    );
  }

  // escalations ---------------------------------------------------------------------------------
  for (const event of visible.filter(
    (e) => e.type === 'escalation' || e.type === 'escalation_response',
  )) {
    add(
      'escalations',
      `escalation:${event.id}`,
      event.type === 'escalation' ? 'Escalation' : 'Escalation response',
      event.title ?? event.type,
      `${formatUtcStamp(event.timestamp)} — ${(event.title ?? event.body).slice(0, 200)}`,
      [refOf(event)],
      0.9,
      'structured',
      event.timestamp,
    );
  }

  // resolution & validation (only when the view reaches them) ---------------------------------
  const resolution =
    input.resolution && known(input.resolution.resolvedAt) ? input.resolution : null;
  if (resolution) {
    const at = resolution.resolvedAt;
    add(
      'resolution',
      'root-cause',
      'Recorded root cause',
      resolution.rootCause,
      resolution.rootCause,
      [],
      0.9,
      'structured',
      at,
    );
    if (resolution.workaround)
      add(
        'resolution',
        'workaround',
        'Workaround',
        resolution.workaround,
        resolution.workaround,
        [],
        0.9,
        'structured',
        at,
      );
    if (resolution.permanentFix)
      add(
        'resolution',
        'permanent-fix',
        'Permanent fix',
        resolution.permanentFix,
        resolution.permanentFix,
        [],
        0.9,
        'structured',
        at,
      );
    if (resolution.validation) {
      add(
        'validation',
        'validation',
        'Validation',
        resolution.validation.method,
        `${resolution.validation.outcome}: ${resolution.validation.method}`,
        [],
        0.9,
        'structured',
        resolution.validation.validatedAt,
      );
    }
  }
  for (const event of visible.filter((e) => e.type === 'validation_result')) {
    add(
      'validation',
      `validation-event:${event.id}`,
      'Validation result',
      event.title ?? 'Validation',
      event.body.slice(0, 400),
      [refOf(event)],
      0.85,
      'rule',
      event.timestamp,
    );
  }

  // remaining risks & unknowns (relative to asOf) -----------------------------------------------
  for (const claim of analysis.claims.filter(
    (c) => c.flags.includes('unvalidated_closure') && known(c.timestamp),
  )) {
    add(
      'remaining_risks',
      `unvalidated:${claim.id}`,
      'Closure without validation',
      claim.text,
      claim.explanation,
      claim.sourceRef ? [claim.sourceRef] : [],
      0.8,
      'derived',
      claim.timestamp,
    );
  }
  if (
    resolution?.permanentFix &&
    /change control|scheduled|pending|will (go|be)|tomorrow/i.test(
      `${resolution.permanentFix} ${resolution.summary}`,
    )
  ) {
    add(
      'remaining_risks',
      'permanent-fix-pending',
      'Permanent fix may still be pending',
      resolution.permanentFix,
      'The permanent fix appears to depend on a later change; the workaround may be carrying the customer until then.',
      [],
      0.6,
      'rule',
      resolution.resolvedAt,
    );
  }
  for (const m of analysis.missing) {
    const resolvedByThen = m.resolvedAt !== null && known(m.resolvedAt);
    if (!known(m.firstRelevantAt) || resolvedByThen) continue;
    add(
      'unknowns',
      `missing:${m.requirementId}`,
      m.label,
      m.label,
      `Not collected yet: ${m.label}. ${m.askText}`,
      [],
      0.9,
      'rule',
      m.firstRelevantAt,
    );
  }
  const lastEvent = visible[visible.length - 1];
  if (lastEvent && !resolution) {
    const step = analysis.timeline.steps.find((s) => s.eventId === lastEvent.id);
    const leader = step ? Object.entries(step.posterior).sort((a, b) => b[1] - a[1])[0] : undefined;
    if (leader) {
      add(
        'unknowns',
        'root-cause-unconfirmed',
        'Root cause not yet confirmed',
        pack.hypotheses.get(leader[0])?.name ?? leader[0],
        `Leading hypothesis “${pack.hypotheses.get(leader[0])?.name ?? leader[0]}” at ${Math.round(leader[1] * 100)}% (model estimate) is not yet confirmed.`,
        [],
        0.8,
        'derived',
        lastEvent.timestamp,
      );
    }
  }

  const participants = deriveParticipants(visible);
  const counts2: Record<string, number> = Object.fromEntries(TWIN_SECTIONS.map((s) => [s, 0]));
  for (const f of fields) counts2[f.section] = (counts2[f.section] ?? 0) + 1;
  // Participants are structural, so they count towards their section.
  counts2.participants = participants.length;
  return {
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    asOf,
    generatedAt: ctx.now,
    fields,
    sectionCounts: counts2,
    participants,
    withheldFutureEventCount: events.length - visibleIds.size,
  };
}

export function deriveParticipants(events: readonly CaseEvent[]): CaseParticipant[] {
  const map = new Map<string, CaseParticipant>();
  for (const e of events) {
    const existing = map.get(e.participantId);
    if (existing) existing.eventCount += 1;
    else
      map.set(e.participantId, {
        id: e.participantId,
        role: e.participantRole,
        alias: e.participantAlias,
        eventCount: 1,
        firstSeenAt: e.timestamp,
      });
  }
  return [...map.values()];
}
