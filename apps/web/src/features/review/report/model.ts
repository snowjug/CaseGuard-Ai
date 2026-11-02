import type {
  ActionExecutor,
  ActionRanking,
  AnalysisRun,
  CaseDetail,
  CaseWarning,
  CoachingReport,
  CounterfactualScenario,
  ForkListResponse,
  MetricEstimate,
  Permission,
  QualityAssessment,
  SkillMatch,
  SkillOverlay,
} from '@caseguard/schemas';
import { formatDateTimeUtc } from '@caseguard/ui';
import { REVIEW_STATE_BADGES } from '../../reasoning/labels';
import { deriveNextActions, type NextActionsModel } from '../model/actions';
import { deriveChronology, type Chronology } from '../model/chronology';
import { deriveDecisionPoints, type DecisionPointModel } from '../model/decisions';
import {
  deriveLearning,
  describeOverlay,
  type LearningMatch,
  type OverlayView,
} from '../model/learning';
import { methodNotes, type MethodNote, type MethodSection } from '../model/method';
import { permissionSentence } from '../model/permissions';
import { derivePaths, type PathsView } from '../model/paths';
import {
  dataOf,
  type Blocked,
  type ClaimReviewRecord,
  type Source,
  type TimelineBundle,
} from '../model/sources';
import { layoutStrip, type StripGeometry } from '../model/strip';
import { shareSummary } from '../model/summary';
import {
  deriveMissedMoment,
  deriveVerdict,
  describeProducer,
  type MissedMoment,
  type VerdictModel,
} from '../model/verdict';
import { capitalise, joinWords } from '../model/words';

/**
 * The decision-ready report as data. It is built from the same derivations as the guided review (the verdict, the
 * chronology, the decision points, the paths, the recommendations, the learning), so the two can never disagree, and it
 * is a pure function of what was read: no clock, no network, nothing from the page. A part the role may not read, or
 * that could not be read, is left out with an explicit note and never replaced by a guess.
 */

export const REPORT_SECTIONS = [
  { id: 'verdict', title: 'Verdict' },
  { id: 'chronology', title: 'Chronology' },
  { id: 'missed', title: 'The earliest important missed moment' },
  { id: 'recorded', title: 'The recorded path' },
  { id: 'better', title: 'The better-supported path' },
  { id: 'recommendations', title: 'Recommendations backed by evidence' },
  { id: 'learning', title: 'Reusable learning' },
  { id: 'method', title: 'Uncertainty and how this was calculated' },
  { id: 'review', title: 'Review and approval' },
] as const;

export type ReportSectionId = (typeof REPORT_SECTIONS)[number]['id'];

/** How many of the matching skills the report explains in full; the rest are counted. */
export const REPORT_MATCHES_SHOWN = 3;
/** How many reviewed claims the report lists; the rest are counted. */
export const REPORT_CLAIMS_SHOWN = 10;

export type Part<T> =
  | {
      state: 'included';
      data: T;
      /** What could not be read and so is missing from an otherwise included section. */
      notes: string[];
    }
  | { state: 'left-out'; cause: 'permission' | 'failed' | 'loading'; note: string };

export interface ReportInput {
  detail: Source<CaseDetail>;
  run: Source<AnalysisRun | null>;
  quality: Source<QualityAssessment>;
  metrics: Source<MetricEstimate[]>;
  coaching: Source<CoachingReport>;
  forks: Source<ForkListResponse>;
  scenarios: Source<CounterfactualScenario[]>;
  warnings: Source<CaseWarning[]>;
  ranking: Source<ActionRanking>;
  matches: Source<SkillMatch[]>;
  /** The skill overlay of each match that was asked for, by match id. */
  overlays: Readonly<Record<string, Source<SkillOverlay>>>;
  timeline: Source<TimelineBundle>;
  claimReviews: Source<ClaimReviewRecord[]>;
  /** When the data was read, in milliseconds since the epoch; 0 when it is not known. */
  readAt: number;
}

export interface ReportHeader {
  reference: string;
  title: string;
  synthetic: boolean;
  facts: { label: string; value: string }[];
}

export interface ChronologyPart {
  chronology: Chronology;
  geometry: StripGeometry;
  decisionsMarked: boolean;
  truncated: { total: number; read: number } | null;
}

export interface RecordedPart {
  /** What was done at the earliest important decision point. */
  decision: {
    number: number;
    title: string;
    at: string;
    did: string;
    kind: string | null;
    effort: string;
    destructive: boolean;
    known: string;
  } | null;
  /** The recorded figures, with where they come from. */
  figures: { label: string; text: string }[];
  figuresFrom: 'simulation' | 'decision point' | 'none';
}

export interface BetterPart {
  view: PathsView;
  decisionPoints: DecisionPointModel[];
}

export interface RecommendationsPart {
  model: NextActionsModel;
}

export interface ReportMatch {
  match: LearningMatch;
  overlay: OverlayView | null;
  /** Why there is no comparison with the skill, when there is none. */
  overlayNote: string | null;
}

export interface LearningPart {
  matches: ReportMatch[];
  /** Matching skills that were not explained because the report lists only the first few. */
  more: number;
  notApplicable: number;
}

export interface MethodPart {
  notes: MethodNote[];
  uncertainty: string[];
}

export type Maybe<T> = { state: 'ready'; items: T[] } | { state: 'unavailable'; note: string };

export interface ReviewPart {
  generated: {
    sentence: string;
    at: string | null;
    runId: string | null;
    producer: string;
  };
  claims:
    | {
        state: 'ready';
        items: ClaimReviewRecord[];
        counts: Record<'confirmed' | 'corrected' | 'rejected', number>;
      }
    | { state: 'unavailable'; note: string };
  paths: Maybe<{
    id: string;
    label: string;
    decision: string | null;
    stateLabel: string;
    by: string | null;
    at: string | null;
    reason: string | null;
  }>;
  dismissedWarnings: Maybe<{
    id: string;
    title: string;
    by: string;
    at: string;
    reason: string;
  }>;
  skillApplications: Maybe<{
    matchId: string;
    skillName: string;
    appliedAt: string | null;
    appliedBy: string | null;
    conformance: string | null;
  }>;
}

export interface ReportModel {
  /** True while any read is still on its way: the page shows a skeleton instead of a report with holes. */
  pending: boolean;
  header: ReportHeader | null;
  fileName: string;
  verdict: Part<{ verdict: VerdictModel }>;
  chronology: Part<ChronologyPart>;
  missed: Part<{ moment: MissedMoment | null }>;
  recorded: Part<RecordedPart>;
  better: Part<BetterPart>;
  recommendations: Part<RecommendationsPart>;
  learning: Part<LearningPart>;
  method: Part<MethodPart>;
  review: Part<ReviewPart>;
  /** The sections left out entirely, in report order, with the words that say why. */
  leftOut: { id: ReportSectionId; title: string; note: string }[];
}

// ------------------------------------------------------------------------------------------------ left-out notes

function leftOutFor(blocked: Blocked, what: string, role: string): Part<never> {
  if (blocked.kind === 'denied') {
    return {
      state: 'left-out',
      cause: 'permission',
      note: permissionSentence({
        permission: blocked.permission,
        what,
        role,
        where: 'in this report',
      }),
    };
  }
  if (blocked.kind === 'failed') {
    return {
      state: 'left-out',
      cause: 'failed',
      note: `${capitalise(what)} could not be read, so it is left out of this report. Reload the page to try again.`,
    };
  }
  return { state: 'left-out', cause: 'loading', note: `${capitalise(what)} was still loading.` };
}

/** The first source that is not ready, preferring a missing permission (which explains itself) over a failure. */
function firstBlocked(sources: readonly Source<unknown>[]): Blocked | null {
  const order = ['denied', 'failed', 'loading'] as const;
  for (const kind of order) {
    const found = sources.find((source) => source.kind === kind);
    if (found && found.kind !== 'ready') return found;
  }
  return null;
}

/**
 * The notes for the sources that are missing from an otherwise included section. A missing permission is explained once
 * however many sources need it (the sources are named together); a read that failed or is still loading gets its own note.
 */
function missingNotes(
  parts: readonly { source: Source<unknown>; what: string }[],
  role: string,
): string[] {
  const missing = new Map<Permission, string[]>();
  const others: string[] = [];
  for (const { source, what } of parts) {
    if (source.kind === 'denied')
      missing.set(source.permission, [...(missing.get(source.permission) ?? []), what]);
    else if (source.kind === 'failed')
      others.push(`${capitalise(what)} could not be read, so it is not included.`);
    else if (source.kind === 'loading') others.push(`${capitalise(what)} was still loading.`);
  }
  const permissions = [...missing].map(([permission, whats]) =>
    permissionSentence({
      permission,
      what: joinWords(whats),
      role,
      several: whats.length > 1,
      where: 'in this report',
    }),
  );
  return [...permissions, ...others];
}

/** The note for one source that is missing from an otherwise included section, or `null` when it is there. */
const missingNote = (source: Source<unknown>, what: string, role: string): string | null =>
  missingNotes([{ source, what }], role)[0] ?? null;

const included = <T>(data: T, notes: string[] = []): Part<T> => ({
  state: 'included',
  data,
  notes,
});

// ------------------------------------------------------------------------------------------------ the parts

function buildHeader(detail: CaseDetail): ReportHeader {
  const facts: ReportHeader['facts'] = [
    { label: 'Status', value: capitalise(detail.status.replace(/_/g, ' ')) },
    { label: 'Opened', value: formatDateTimeUtc(detail.openedAt) },
  ];
  if (detail.closedAt) facts.push({ label: 'Closed', value: formatDateTimeUtc(detail.closedAt) });
  facts.push(
    { label: 'Product', value: detail.product },
    { label: 'Events on record', value: String(detail.eventCount) },
  );
  return { reference: detail.reference, title: detail.title, synthetic: detail.synthetic, facts };
}

/** A file name from the case reference that is safe on every system. */
export function reportFileName(reference: string | null): string {
  const safe = (reference ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return `${safe || 'case'}-guided-review.html`;
}

function buildVerdict(input: ReportInput, role: string): Part<{ verdict: VerdictModel }> {
  const { quality, detail } = input;
  if (quality.kind !== 'ready') return leftOutFor(quality, 'the case quality result', role);
  if (detail.kind !== 'ready') return leftOutFor(detail, 'the case record', role);
  const notes = missingNotes(
    [
      { source: input.coaching, what: 'the coach’s summary' },
      { source: input.metrics, what: 'the avoidable support effort' },
      { source: input.forks, what: 'the count of decision points' },
    ],
    role,
  );
  return included(
    {
      verdict: deriveVerdict({
        quality: quality.data,
        coaching: dataOf(input.coaching),
        forks: dataOf(input.forks),
        detail: detail.data,
        metrics: dataOf(input.metrics),
      }),
    },
    notes,
  );
}

function buildChronology(input: ReportInput, role: string): Part<ChronologyPart> {
  const { timeline, forks, detail } = input;
  if (timeline.kind !== 'ready') return leftOutFor(timeline, 'the chronology', role);
  const resolvedAt = detail.kind === 'ready' ? (detail.data.resolution?.resolvedAt ?? null) : null;
  const chronology = deriveChronology(timeline.data.events, dataOf(forks), resolvedAt);
  const notes = [missingNote(forks, 'the decision points', role)].filter(
    (note): note is string => note !== null,
  );
  return included(
    {
      chronology,
      geometry: layoutStrip(chronology),
      decisionsMarked: forks.kind === 'ready',
      truncated: timeline.data.truncated
        ? { total: timeline.data.total, read: timeline.data.events.length }
        : null,
    },
    notes,
  );
}

function buildMissed(input: ReportInput, role: string): Part<{ moment: MissedMoment | null }> {
  if (input.forks.kind !== 'ready') return leftOutFor(input.forks, 'the decision points', role);
  return included({ moment: deriveMissedMoment(input.forks.data) });
}

function buildRecorded(input: ReportInput, role: string): Part<RecordedPart> {
  const { forks, scenarios } = input;
  if (forks.kind !== 'ready') return leftOutFor(forks, 'the decision points', role);
  const points = deriveDecisionPoints(forks.data);
  const point = points.find((item) => item.isEarliest) ?? points[0] ?? null;
  const view = scenarios.kind === 'ready' ? derivePaths(forks.data, scenarios.data) : null;
  const notes = [missingNote(scenarios, 'the simulated paths', role)].filter(
    (note): note is string => note !== null,
  );
  const decision = point
    ? {
        number: point.number,
        title: point.title,
        at: point.at,
        did: point.did.label,
        kind: point.did.kindLabel,
        effort: point.did.effortLabel,
        destructive: point.did.destructive,
        known: point.known.summary,
      }
    : null;
  if (view?.kind === 'ready') {
    return included(
      {
        decision,
        figures: view.path.rows.map((row) => ({ label: row.label, text: row.recordedText })),
        figuresFrom: 'simulation',
      },
      notes,
    );
  }
  return included(
    {
      decision,
      figures: point ? [{ label: 'Time to useful evidence', text: point.estimate.didTime }] : [],
      figuresFrom: point ? 'decision point' : 'none',
    },
    notes,
  );
}

function buildBetter(input: ReportInput, role: string): Part<BetterPart> {
  const { forks, scenarios } = input;
  if (forks.kind !== 'ready' || scenarios.kind !== 'ready') {
    return leftOutFor(
      firstBlocked([forks, scenarios]) ?? { kind: 'loading' },
      'the simulated paths',
      role,
    );
  }
  return included({
    view: derivePaths(forks.data, scenarios.data),
    decisionPoints: deriveDecisionPoints(forks.data),
  });
}

function buildRecommendations(input: ReportInput, role: string): Part<RecommendationsPart> {
  const { quality, warnings, coaching, ranking, scenarios } = input;
  const sources = [quality, coaching, warnings, ranking];
  if (sources.every((source) => source.kind !== 'ready')) {
    return leftOutFor(firstBlocked(sources) ?? { kind: 'loading' }, 'the recommendations', role);
  }
  const executors = new Map<string, ActionExecutor>();
  for (const scenario of dataOf(scenarios) ?? [])
    for (const step of scenario.steps)
      if (!executors.has(step.actionKey)) executors.set(step.actionKey, step.executor);
  const notes = missingNotes(
    [
      { source: quality, what: 'the quality improvements' },
      { source: coaching, what: 'the coach’s suggestion' },
      { source: warnings, what: 'the warnings' },
      { source: ranking, what: 'the ranked diagnostic steps' },
    ],
    role,
  );
  return included(
    {
      model: deriveNextActions({
        quality: dataOf(quality),
        warnings: dataOf(warnings),
        coaching: dataOf(coaching),
        ranking: dataOf(ranking),
        executors,
      }),
    },
    notes,
  );
}

function buildLearning(input: ReportInput, role: string): Part<LearningPart> {
  const { matches, overlays } = input;
  if (matches.kind !== 'ready') return leftOutFor(matches, 'the matching skills', role);
  const model = deriveLearning(matches.data);
  const shown = model.matches.slice(0, REPORT_MATCHES_SHOWN);
  return included({
    matches: shown.map((match) => {
      const source = overlays[match.matchId];
      if (source?.kind === 'ready')
        return { match, overlay: describeOverlay(source.data), overlayNote: null };
      const note = source
        ? missingNote(source, 'the comparison with the skill', role)
        : 'The comparison with the skill was not read.';
      return { match, overlay: null, overlayNote: note };
    }),
    more: model.matches.length - shown.length,
    notApplicable: model.notApplicable,
  });
}

type CoreParts = Pick<
  ReportModel,
  'verdict' | 'chronology' | 'missed' | 'recorded' | 'better' | 'recommendations' | 'learning'
>;

/** The sections that carry a method note of their own, and which note. */
const SECTION_NOTES: readonly [keyof CoreParts, MethodSection][] = [
  ['verdict', 'verdict'],
  ['chronology', 'chronology'],
  ['missed', 'decisions'],
  ['better', 'paths'],
  ['recommendations', 'actions'],
  ['learning', 'learning'],
];

function buildMethod(input: ReportInput, parts: CoreParts): Part<MethodPart> {
  const run = dataOf(input.run);
  const quality = dataOf(input.quality);
  const path =
    parts.better.state === 'included' && parts.better.data.view.kind === 'ready'
      ? parts.better.data.view.path
      : null;
  const context = {
    run,
    quality,
    qualityDenied: input.quality.kind === 'denied',
    coaching: dataOf(input.coaching),
    detail: dataOf(input.detail),
    path,
  };
  const notes: MethodNote[] = [...methodNotes('overall', context)];
  const seen = new Set(notes.map((note) => note.heading));
  for (const [sectionId, methodSection] of SECTION_NOTES) {
    if (parts[sectionId].state !== 'included') continue;
    for (const note of methodNotes(methodSection, context)) {
      if (seen.has(note.heading)) continue;
      seen.add(note.heading);
      notes.push(note);
    }
  }
  const uncertainty: string[] = [];
  if (quality) uncertainty.push(quality.uncertaintyNote);
  if (path)
    uncertainty.push(
      `${path.confidence.label}: ${path.confidence.rationale}`,
      'Every figure of the better-supported path is a simulated estimate. Nothing in it happened.',
    );
  uncertainty.push(
    'Estimated figures are model estimates with a plausible range, not measurements. Where a range includes the recorded figure, the report does not claim a difference.',
  );
  return included({ notes, uncertainty });
}

function buildReview(input: ReportInput, role: string): Part<ReviewPart> {
  const run = dataOf(input.run);
  const readAt = input.readAt > 0 ? new Date(input.readAt).toISOString() : null;
  const producer = describeProducer(run);
  const generated: ReviewPart['generated'] = {
    sentence: `Generated ${readAt ? `at ${formatDateTimeUtc(readAt)} ` : ''}from ${
      run ? `analysis run ${run.id}` : 'an analysis run that could not be read'
    }. ${producer.sentence}`,
    at: readAt,
    runId: run?.id ?? null,
    producer: producer.sentence,
  };
  const unavailable = (
    source: Source<unknown>,
    what: string,
  ): { state: 'unavailable'; note: string } => ({
    state: 'unavailable',
    note: missingNote(source, what, role) ?? `${capitalise(what)} is not available.`,
  });

  const claims: ReviewPart['claims'] =
    input.claimReviews.kind === 'ready'
      ? {
          state: 'ready',
          items: input.claimReviews.data,
          counts: input.claimReviews.data.reduce(
            (count, claim) => ({ ...count, [claim.state]: count[claim.state] + 1 }),
            { confirmed: 0, corrected: 0, rejected: 0 },
          ),
        }
      : unavailable(input.claimReviews, 'the claim reviews');

  const forksData = dataOf(input.forks);
  const decisions = forksData ? deriveDecisionPoints(forksData) : [];
  const paths: ReviewPart['paths'] =
    input.scenarios.kind === 'ready'
      ? {
          state: 'ready',
          items: input.scenarios.data
            .filter((scenario) => scenario.reviewState !== 'pending')
            .map((scenario) => ({
              id: scenario.id,
              label: scenario.label,
              decision: decisions.find((point) => point.forkId === scenario.forkId)?.title ?? null,
              stateLabel: REVIEW_STATE_BADGES[scenario.reviewState].label,
              by: scenario.reviewedBy,
              at: scenario.reviewedAt,
              reason: scenario.reviewReason,
            })),
        }
      : unavailable(input.scenarios, 'the reviews of the simulated paths');

  const dismissedWarnings: ReviewPart['dismissedWarnings'] =
    input.warnings.kind === 'ready'
      ? {
          state: 'ready',
          items: input.warnings.data.flatMap((warning) =>
            warning.state === 'dismissed' && warning.dismissal
              ? [
                  {
                    id: warning.id,
                    title: warning.title,
                    by: warning.dismissal.by,
                    at: warning.dismissal.at,
                    reason: warning.dismissal.reason,
                  },
                ]
              : [],
          ),
        }
      : unavailable(input.warnings, 'the dismissed warnings');

  const skillApplications: ReviewPart['skillApplications'] =
    input.matches.kind === 'ready'
      ? {
          state: 'ready',
          items: deriveLearning(input.matches.data)
            .matches.filter((match) => match.applied)
            .map((match) => ({
              matchId: match.matchId,
              skillName: match.skillName,
              appliedAt: match.appliedAt,
              appliedBy: match.appliedBy,
              conformance: match.conformanceText,
            })),
        }
      : unavailable(input.matches, 'the skill applications');

  return included({ generated, claims, paths, dismissedWarnings, skillApplications });
}

/** Builds the report from what was read. Pure: the same input gives the same report. */
export function buildReport(input: ReportInput, role: string): ReportModel {
  const all: readonly Source<unknown>[] = [
    input.detail,
    input.run,
    input.quality,
    input.metrics,
    input.coaching,
    input.forks,
    input.scenarios,
    input.warnings,
    input.ranking,
    input.matches,
    input.timeline,
    input.claimReviews,
  ];
  const parts = {
    verdict: buildVerdict(input, role),
    chronology: buildChronology(input, role),
    missed: buildMissed(input, role),
    recorded: buildRecorded(input, role),
    better: buildBetter(input, role),
    recommendations: buildRecommendations(input, role),
    learning: buildLearning(input, role),
  };
  const method = buildMethod(input, parts);
  const review = buildReview(input, role);
  const sections = { ...parts, method, review };
  const reference = input.detail.kind === 'ready' ? input.detail.data.reference : null;
  return {
    pending: all.some((source) => source.kind === 'loading'),
    header: input.detail.kind === 'ready' ? buildHeader(input.detail.data) : null,
    fileName: reportFileName(reference),
    ...sections,
    leftOut: REPORT_SECTIONS.flatMap((section) => {
      const part = sections[section.id];
      return part.state === 'left-out'
        ? [{ id: section.id, title: section.title, note: part.note }]
        : [];
    }),
  };
}

/**
 * The plain-text summary for "Copy summary": the verdict, the earliest missed moment and the first recommendations, from the
 * report, with what was left out named and the address of the full report. The same words as the Share section.
 */
export function reportSummary(report: ReportModel, reportUrl: string): string {
  const verdict = report.verdict.state === 'included' ? report.verdict.data.verdict : null;
  const missed = report.missed.state === 'included' ? report.missed.data.moment : undefined;
  const actions =
    report.recommendations.state === 'included' ? report.recommendations.data.model : null;
  return shareSummary({
    reference: report.header?.reference ?? 'unknown case',
    title: report.header?.title ?? 'the case record could not be read',
    synthetic: report.header?.synthetic ?? false,
    verdict,
    missed,
    actions,
    reportUrl,
    notIncluded: report.leftOut.map((item) => item.title.toLowerCase()),
  });
}
