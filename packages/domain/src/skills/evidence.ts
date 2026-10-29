import type { SkillCondition } from '@caseguard/schemas';
import { eventText } from '../engine/signals';
import type { ViewAnalysis } from '../engine/state';

/** Case facts that are not evidence but still scope a skill (workload and product). */
export interface CaseInfo {
  workload: string;
  product: string;
}

export interface SignalSighting {
  /** Evidence ids (one per observation) so matches can point at their supporting evidence. */
  evidenceIds: string[];
  eventIds: string[];
  firstObservedAt: string;
}

/**
 * What is known about a case at one instant, derived only from the events inside the temporal view
 * it was built from. Matching never receives anything else, so it cannot see the future.
 */
export interface EvidenceIndex {
  asOf: string;
  signals: ReadonlyMap<string, SignalSighting>;
  satisfied: ReadonlySet<string>;
  attributes: Readonly<Record<string, string | boolean>>;
  texts: readonly string[];
}

const MAX_TEXT_PER_EVENT = 4000;

export function buildEvidenceIndex(analysis: ViewAnalysis, caseInfo: CaseInfo): EvidenceIndex {
  const signals = new Map<string, SignalSighting>();
  for (const obs of analysis.observations) {
    const sighting = signals.get(obs.signalId) ?? {
      evidenceIds: [],
      eventIds: [],
      firstObservedAt: obs.timestamp,
    };
    sighting.evidenceIds.push(obs.id);
    if (!sighting.eventIds.includes(obs.eventId)) sighting.eventIds.push(obs.eventId);
    if (obs.timestamp < sighting.firstObservedAt) sighting.firstObservedAt = obs.timestamp;
    signals.set(obs.signalId, sighting);
  }
  const satisfied = analysis.rankingState.satisfied;
  // Attribute vocabulary: `workload`, `product`, `signal.<id>` and `requirement.<id>`.
  const attributes: Record<string, string | boolean> = {
    workload: caseInfo.workload,
    product: caseInfo.product,
  };
  for (const id of signals.keys()) attributes[`signal.${id}`] = true;
  for (const id of satisfied) attributes[`requirement.${id}`] = true;
  return {
    asOf: analysis.view.asOf,
    signals,
    satisfied,
    attributes,
    texts: analysis.view.events.map((e) => eventText(e).slice(0, MAX_TEXT_PER_EVENT)),
  };
}

export interface ConditionEvaluation {
  condition: SkillCondition;
  holds: boolean;
  evidenceIds: string[];
  /** Why a condition could not be evaluated as written (never thrown, always explained). */
  note: string | null;
}

// A repeated group that itself repeats or alternates is the classic catastrophic-backtracking shape
// (`(a+)+`, `(a|aa)+`), as are back-references.
const RISKY_REPETITION = /\((?:[^()\\]|\\.)*[+*{|](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;
const BACK_REFERENCE = /\\[1-9]|\\k</;

/**
 * Skill text conditions are stored data, possibly proposed by a model, so they are only ever run when
 * they compile and avoid the patterns that can backtrack catastrophically.
 */
export function isSafeConditionPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 300) return false;
  if (RISKY_REPETITION.test(pattern) || BACK_REFERENCE.test(pattern)) return false;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

export function evaluateCondition(
  condition: SkillCondition,
  index: EvidenceIndex,
): ConditionEvaluation {
  const result = (holds: boolean, evidenceIds: string[] = [], note: string | null = null) => ({
    condition,
    holds,
    evidenceIds,
    note,
  });
  switch (condition.kind) {
    case 'signal': {
      if (!condition.signalId) return result(false, [], 'The condition names no signal.');
      const sighting = index.signals.get(condition.signalId);
      return sighting ? result(true, sighting.evidenceIds) : result(false);
    }
    case 'attribute': {
      if (!condition.attribute) return result(false, [], 'The condition names no attribute.');
      const separator = condition.attribute.indexOf('=');
      const key = separator < 0 ? condition.attribute : condition.attribute.slice(0, separator);
      const wanted = separator < 0 ? null : condition.attribute.slice(separator + 1);
      const actual = index.attributes[key];
      const holds =
        wanted === null ? actual !== undefined && actual !== false : String(actual) === wanted;
      const signalId = key.startsWith('signal.') ? key.slice('signal.'.length) : null;
      const evidenceIds = holds && signalId ? (index.signals.get(signalId)?.evidenceIds ?? []) : [];
      return result(holds, evidenceIds);
    }
    case 'text': {
      const pattern = condition.pattern;
      if (!pattern) return result(false, [], 'The condition has no pattern.');
      if (!isSafeConditionPattern(pattern)) {
        return result(
          false,
          [],
          'The pattern was not evaluated because it is not considered safe.',
        );
      }
      const regex = new RegExp(pattern, 'i');
      return result(index.texts.some((text) => regex.test(text)));
    }
  }
}
