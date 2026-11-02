import {
  type ActionExecutor,
  type ActionRanking,
  type CaseWarning,
  type CoachingReport,
  type EvidenceLink,
  type Improvement,
  type Priority,
  type QualityAssessment,
} from '@caseguard/schemas';
import { formatNumber, type BadgeStatus } from '@caseguard/ui';
import { EXECUTOR_LABELS } from '../../reasoning/labels';
import { uniqueLinks } from './links';
import { clipWords } from './words';

export type ActionSource = 'improvement' | 'warning' | 'coaching' | 'diagnostic';

export const SOURCE_WORDS: Record<ActionSource, string> = {
  improvement: 'Quality improvement',
  warning: 'Open warning',
  coaching: 'Coach’s suggestion',
  diagnostic: 'Next diagnostic step',
};

export const PRIORITY_WORDS: Record<Priority, { label: string; badge: BadgeStatus }> = {
  critical: { label: 'Critical', badge: 'unsupported' },
  high: { label: 'High priority', badge: 'uncertain' },
  medium: { label: 'Medium priority', badge: 'neutral' },
  low: { label: 'Low priority', badge: 'neutral' },
};

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SOURCE_RANK: Record<ActionSource, number> = {
  warning: 0,
  improvement: 1,
  diagnostic: 2,
  coaching: 3,
};

/** Shown on a recommendation that has no case-specific evidence behind it. Never hidden, never given an invented link. */
export const GENERAL_GUIDANCE = 'General guidance — no case-specific evidence';

export interface NextAction {
  id: string;
  source: ActionSource;
  sourceLabel: string;
  title: string;
  /** Why it is recommended, in the engine's own words. */
  reason: string;
  /** What to do, when the source states it apart from the title (a warning's suggested action). */
  suggestion: string | null;
  priority: Priority;
  priorityLabel: string;
  priorityBadge: BadgeStatus;
  /** Who would do it, only where the data says so. */
  owner: string | null;
  /** The expected gain, only where the engine gives one; always an estimate. */
  gain: string | null;
  /** The size of that gain in the engine's own unit, for ordering only (0 when there is none). */
  gainSize: number;
  links: EvidenceLink[];
  hasEvidence: boolean;
  /** True when the coach's recommended next action says the same thing. */
  alsoCoachesNext: boolean;
}

export interface NextActionsModel {
  items: NextAction[];
  /** How the warnings of the case stand, so a case with none open still says what became of them. */
  warnings: { open: number; resolved: number; dismissed: number };
  /** Why there is no diagnostic step on the list, when the case is already settled. */
  noDiagnosticNote: string | null;
}

export interface NextActionsInput {
  quality: QualityAssessment | null;
  warnings: readonly CaseWarning[] | null;
  coaching: CoachingReport | null;
  ranking: ActionRanking | null;
  /** Who carries out each action, where the data says so (the steps of a simulated path name an executor). */
  executors?: ReadonlyMap<string, ActionExecutor>;
}

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function fromImprovement(improvement: Improvement, alsoCoachesNext: boolean): NextAction {
  const priority = PRIORITY_WORDS[improvement.priority];
  const links = uniqueLinks(improvement.evidence);
  return {
    id: `improvement:${improvement.id}`,
    source: 'improvement',
    sourceLabel: SOURCE_WORDS.improvement,
    title: improvement.title,
    reason: improvement.description,
    suggestion: null,
    priority: improvement.priority,
    priorityLabel: priority.label,
    priorityBadge: priority.badge,
    owner: null,
    gain:
      improvement.expectedScoreGain > 0
        ? `About +${formatNumber(improvement.expectedScoreGain, { maximumFractionDigits: 1 })} points of case quality (estimate)`
        : null,
    gainSize: improvement.expectedScoreGain,
    links,
    hasEvidence: links.length > 0,
    alsoCoachesNext,
  };
}

function fromWarning(warning: CaseWarning): NextAction {
  const priority = PRIORITY_WORDS[warning.priority];
  const links = uniqueLinks(warning.evidence);
  return {
    id: `warning:${warning.id}`,
    source: 'warning',
    sourceLabel: SOURCE_WORDS.warning,
    title: warning.title,
    reason: warning.message,
    suggestion: warning.suggestedAction,
    priority: warning.priority,
    priorityLabel: priority.label,
    priorityBadge: priority.badge,
    owner: null,
    gain: null,
    gainSize: 0,
    links,
    hasEvidence: links.length > 0,
    alsoCoachesNext: false,
  };
}

function fromCoaching(item: NonNullable<CoachingReport['recommendedNextAction']>): NextAction {
  const priority = PRIORITY_WORDS.low;
  const links = uniqueLinks(item.evidence);
  return {
    id: 'coaching:next',
    source: 'coaching',
    sourceLabel: SOURCE_WORDS.coaching,
    title: item.title,
    reason: item.detail,
    suggestion: null,
    priority: 'low',
    priorityLabel: priority.label,
    priorityBadge: priority.badge,
    owner: null,
    gain: null,
    gainSize: 0,
    links,
    hasEvidence: links.length > 0,
    alsoCoachesNext: false,
  };
}

/** Only a step that would add information is worth recommending: a settled case ranks every step at zero. */
function usefulCandidates(ranking: ActionRanking): ActionRanking['candidates'] {
  return ranking.candidates
    .filter(
      (candidate) =>
        candidate.safety.allowed &&
        candidate.score > 0 &&
        candidate.inputs.expectedInformationGainBits > 0,
    )
    .sort((a, b) => a.rank - b.rank);
}

function fromCandidate(
  candidate: ActionRanking['candidates'][number],
  executors: ReadonlyMap<string, ActionExecutor> | undefined,
): NextAction {
  const priority = candidate.rank === 1 ? 'high' : 'medium';
  const words = PRIORITY_WORDS[priority];
  const executor = executors?.get(candidate.actionKey);
  return {
    id: `diagnostic:${candidate.actionKey}`,
    source: 'diagnostic',
    sourceLabel: SOURCE_WORDS.diagnostic,
    title: candidate.label,
    reason: candidate.explanation,
    suggestion: null,
    priority,
    priorityLabel: words.label,
    priorityBadge: words.badge,
    owner: executor ? EXECUTOR_LABELS[executor] : null,
    gain: `About ${formatNumber(candidate.inputs.expectedInformationGainBits, { maximumFractionDigits: 2 })} bits of new information (estimate)`,
    gainSize: 0,
    links: [],
    hasEvidence: false,
    alsoCoachesNext: false,
  };
}

/**
 * The one ranked list of what to do next: the quality improvements, the warnings still open with their suggested
 * action, the coach's recommended next action and the best-ranked diagnostic steps. Most urgent first; within a
 * priority, an open warning before an improvement before a diagnostic step before a suggestion, and the larger expected
 * gain first. A recommendation the coach repeats is listed once and marked, never twice.
 */
export function deriveNextActions(input: NextActionsInput): NextActionsModel {
  const { quality, warnings, coaching, ranking, executors } = input;
  const coachTitle = coaching?.recommendedNextAction
    ? normalise(coaching.recommendedNextAction.title)
    : null;
  const items: NextAction[] = [];
  let coachRepeated = false;
  for (const improvement of quality?.improvements ?? []) {
    const repeated = coachTitle !== null && coachTitle.includes(normalise(improvement.title));
    if (repeated) coachRepeated = true;
    items.push(fromImprovement(improvement, repeated));
  }
  for (const warning of warnings ?? [])
    if (warning.state === 'open') items.push(fromWarning(warning));
  if (coaching?.recommendedNextAction && !coachRepeated)
    items.push(fromCoaching(coaching.recommendedNextAction));
  const useful = ranking ? usefulCandidates(ranking).slice(0, 3) : [];
  for (const candidate of useful) items.push(fromCandidate(candidate, executors));

  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] ||
        SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source] ||
        b.item.gainSize - a.item.gainSize ||
        a.index - b.index,
    )
    .map(({ item }) => item);

  const states = (warnings ?? []).reduce(
    (count, warning) => ({ ...count, [warning.state]: count[warning.state] + 1 }),
    { open: 0, resolved: 0, dismissed: 0 },
  );
  return {
    items: sorted,
    warnings: states,
    noDiagnosticNote:
      ranking && useful.length === 0
        ? 'No diagnostic step is ranked as adding information at this point.'
        : null,
  };
}

/** The first line of a reason, for the list; the full text stays one disclosure away. */
export function reasonLine(action: NextAction, max = 160): string {
  return clipWords(action.reason, max);
}
