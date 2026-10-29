import { ENGINEER_SIDE_ROLES, type CaseEvent, type Level } from '@caseguard/schemas';
import { buildTimelineResponse, rankActions } from '@caseguard/domain';
import type {
  EvidenceClassification,
  ForkProposals,
  HypothesisProposals,
  TimelineAnalysis,
} from '../../agents/outputs';
import type {
  EvidenceTaskInput,
  ForkTaskInput,
  HypothesisTaskInput,
  TimelineTaskInput,
} from '../../agents/tasks';
import { confidenceLevel, hypothesisStandingAsOf, likelihoodLevel } from '../../context/derive';
import { scopeAnalysis } from '../../context/scope';
import { AiTaskError } from '../../errors';
import { clip, isRecommendable, oneLine, percent, unique, uncertainty } from './shared';

const DIAGNOSTIC_TYPES: ReadonlySet<string> = new Set([
  'diagnostic_result',
  'log_sample',
  'query_output',
]);

const titleOf = (event: CaseEvent | undefined): string =>
  event ? oneLine(event.title ?? event.body, 80) : 'unknown event';

/** Timeline analysis built on the domain timeline view model (delays, repeats) and the event record. */
export function runTimelineAnalyzer(input: TimelineTaskInput): TimelineAnalysis {
  const scoped = scopeAnalysis(input);
  const events = input.view.events;
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last)
    throw new AiTaskError('invalid_input', 'The temporal view contains no events.');
  const byId = new Map(events.map((e) => [e.id, e]));
  const response = buildTimelineResponse({
    caseRecord: { id: input.ctx.caseId, openedAt: first.timestamp },
    events,
    analysis: input.analysis,
    asOf: null,
    limit: events.length,
  });

  const keyMoments: TimelineAnalysis['keyMoments'] = [];
  const addMoment = (event: CaseEvent | undefined, label: string): void => {
    if (!event || keyMoments.length >= 15 || keyMoments.some((m) => m.eventId === event.id)) return;
    keyMoments.push({
      eventId: event.id,
      label,
      note: oneLine(event.title ? `${event.title}. ${event.body}` : event.body, 280),
    });
  };
  addMoment(first, 'Case opened with the first report');
  addMoment(
    events.find((e) => ENGINEER_SIDE_ROLES.includes(e.participantRole)),
    'First engineer response',
  );
  addMoment(
    events.find((e) => DIAGNOSTIC_TYPES.has(e.type)),
    'First diagnostic output',
  );
  const earliest = scoped.forks.find((f) => f.isEarliestMeaningful);
  addMoment(earliest ? byId.get(earliest.eventId) : undefined, 'Earliest meaningful decision fork');
  addMoment(
    events.find((e) => e.type === 'escalation'),
    'Escalation',
  );
  addMoment(
    events.find((e) => e.type === 'resolution_note'),
    'Resolution recorded',
  );
  addMoment(
    events.find((e) => e.type === 'validation_result'),
    'Validation recorded',
  );
  addMoment(last, 'Latest recorded event');

  const delays = response.delays.slice(0, 15).map((d) => ({
    fromEventId: d.fromEventId,
    toEventId: d.toEventId,
    minutes: Math.round(d.minutes),
    note: clip(
      `${d.reason} Between “${titleOf(byId.get(d.fromEventId))}” and “${titleOf(byId.get(d.toEventId))}”.`,
      240,
    ),
  }));
  const labelByEvent = new Map(scoped.actions.map((a) => [a.eventId, a.label]));
  const repeatedDiagnostics = response.repeats
    .filter((r) => r.repeatOfEventId !== r.eventId)
    .slice(0, 15)
    .map((r) => ({
      eventIds: [r.repeatOfEventId, r.eventId],
      note: clip(
        `“${labelByEvent.get(r.eventId) ?? titleOf(byId.get(r.eventId))}” was requested again although an earlier result was on record.`,
        240,
      ),
    }));

  const leader = Math.max(...Object.values(scoped.state.belief));
  const level: Level = leader >= 0.75 ? 'low' : leader >= 0.5 ? 'medium' : 'high';
  return {
    summary: clip(
      `${events.length} events from ${first.timestamp} to ${last.timestamp} UTC; ${delays.length} long wait(s) and ${repeatedDiagnostics.length} repeated diagnostic(s) were found. Dates and gaps come from the record; interpretation of causes is a model estimate.`,
      800,
    ),
    keyMoments,
    delays,
    repeatedDiagnostics,
    uncertainty: uncertainty(
      level,
      'Timeline facts come from recorded events; the leading explanation is a model estimate and may change.',
    ),
  };
}

/** Classifies the case's statements with the domain's rule-based evidence ledger (original classification). */
export function runEvidenceClassifier(input: EvidenceTaskInput): EvidenceClassification {
  const scoped = scopeAnalysis(input);
  const wanted = input.claimIds ? new Set(input.claimIds) : null;
  const claims = scoped.claims.filter((c) => c.eventId !== null && (!wanted || wanted.has(c.id)));
  const evidenceIds = new Set(scoped.evidence.map((e) => e.id));
  return {
    classifications: claims.slice(0, 150).map((c) => ({
      claimId: c.id,
      category: c.aiCategory,
      confidence: confidenceLevel(c.confidence),
      rationale: clip(`${oneLine(c.text, 160)}. ${oneLine(c.explanation, 220)}`, 400),
      eventIds: c.eventId ? [c.eventId] : [],
      evidenceIds: c.supportingEvidenceIds.filter((id) => evidenceIds.has(id)).slice(0, 8),
    })),
    uncertainty: uncertainty(
      'medium',
      'Classifications come from authored lexicon and pattern rules; unusual phrasing can be misclassified and should be reviewed.',
    ),
  };
}

/** Competing hypotheses with as-of standing, supporting and contradicting evidence and the cheapest safe test. */
export function runHypothesisGenerator(input: HypothesisTaskInput): HypothesisProposals {
  const scoped = scopeAnalysis(input);
  const { pack, analysis, config } = input;
  const state = scoped.state.rankingState;
  const ranked = rankActions(pack, config, state).candidates;
  const eventByEvidence = new Map(scoped.evidence.map((e) => [e.id, e.eventId]));
  const labelByEvidence = new Map(scoped.evidence.map((e) => [e.id, e.label]));
  const first = input.view.events[0];

  const candidates = pack.pack.hypotheses
    .map((h) => ({
      h,
      p: scoped.state.belief[h.id] ?? 0,
      record: analysis.hypotheses.find((x) => x.key === h.id),
    }))
    .map((c) => {
      const links = c.record ? scoped.links.filter((l) => l.hypothesisId === c.record?.id) : [];
      const strongest = (polarity: 'supports' | 'contradicts') =>
        links
          .filter((l) => l.polarity === polarity)
          .sort(
            (a, b) =>
              Math.abs(b.logLikelihoodRatio) - Math.abs(a.logLikelihoodRatio) ||
              (a.evidenceId < b.evidenceId ? -1 : 1),
          )
          .slice(0, 4)
          .map((l) => l.evidenceId);
      return { ...c, supporting: strongest('supports'), contradicting: strongest('contradicts') };
    });
  const withEvidence = candidates.filter((c) => c.supporting.length + c.contradicting.length > 0);
  const chosen = (withEvidence.length > 0 ? withEvidence : candidates.slice(0, 1))
    .sort((a, b) => b.p - a.p || (a.h.id < b.h.id ? -1 : 1))
    .slice(0, 10);

  const hypotheses = chosen.map(({ h, p, record, supporting, contradicting }) => {
    const standing = record
      ? hypothesisStandingAsOf(record, scoped.eventIds)
      : { status: 'active' as const };
    const cited = [...supporting, ...contradicting];
    const events = unique(
      cited.flatMap((id) => {
        const eventId = eventByEvidence.get(id);
        return eventId ? [eventId] : [];
      }),
    ).slice(0, 6);
    const missing = h.confirmationRequirementIds
      .filter((r) => !state.satisfied.has(r))
      .map((r) => clip(pack.requirements.get(r)?.label ?? r, 200))
      .slice(0, 8);
    const action = ranked.find(
      (e) => e.action.targets.includes(h.id) && isRecommendable(e.action, config.riskCeiling),
    );
    const names = (ids: readonly string[]): string =>
      unique(ids.map((id) => labelByEvidence.get(id) ?? id)).join('; ');
    const rationale = [
      `${h.name} stands at ${percent(p)} (model estimate).`,
      supporting.length > 0 ? `Supported by: ${names(supporting)}.` : '',
      contradicting.length > 0 ? `Contradicted by: ${names(contradicting)}.` : '',
      cited.length === 0 ? 'No discriminating evidence yet; this is the knowledge-pack prior.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      key: h.id,
      name: clip(h.name, 120),
      description: clip(h.description, 400),
      category: h.category,
      status: standing.status,
      likelihood: likelihoodLevel(p),
      rationale: clip(rationale, 500),
      supportingEvidenceIds: supporting,
      contradictingEvidenceIds: contradicting,
      eventIds: events.length > 0 ? events : first ? [first.id] : [],
      missingEvidence: missing,
      cheapestSafeActionKey: action ? action.action.id : null,
    };
  });
  return {
    hypotheses,
    uncertainty: uncertainty(
      'medium',
      'Likelihood bands are model estimates from an authored knowledge pack, not statistical truth.',
    ),
  };
}

/** Decision forks detected by the domain engine using only decision-time information. */
export function runForkDetector(input: ForkTaskInput): ForkProposals {
  const scoped = scopeAnalysis(input);
  const { pack, config } = input;
  const evidenceIds = new Set(scoped.evidence.map((e) => e.id));
  const labelByEvidence = new Map(scoped.evidence.map((e) => [e.id, e.label]));
  const forks = scoped.forks.slice(0, 20).map((f) => {
    const alternative = f.alternatives.find(
      (a) => a.safe && isRecommendable(pack.actions.get(a.actionKey), config.riskCeiling),
    );
    const known = f.informationAvailable.evidenceIds
      .filter((id) => evidenceIds.has(id))
      .slice(0, 10);
    const labels = unique(known.map((id) => labelByEvidence.get(id) ?? id)).slice(0, 4);
    return {
      eventId: f.eventId,
      category: f.category,
      severity: f.severity,
      title: clip(f.title, 160),
      rationale: clip(
        `${f.actual.label}. ${f.summary}${labels.length > 0 ? ` Known at the time: ${labels.join('; ')}.` : ''}`,
        600,
      ),
      evidenceIds: known,
      alternativeActionKey: alternative ? alternative.actionKey : null,
    };
  });
  return {
    forks,
    uncertainty: uncertainty(
      'medium',
      'Forks are detected from decision-time information with a configurable heuristic; reviewers can reject any of them.',
    ),
  };
}
