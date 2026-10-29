import type {
  DecisionStep,
  SkillContent,
  SkillDiff,
  SkillDiffChange,
  SkillVersion,
} from '@caseguard/schemas';
import { hashJson } from '../util/ids';
import { clip } from './util';

type Section = SkillDiffChange['section'];

const same = (a: unknown, b: unknown): boolean => hashJson(a) === hashJson(b);
const show = (value: string | number | null | undefined): string =>
  value === undefined || value === null ? 'none' : String(value);

interface KeyedSpec<T> {
  section: Section;
  path: string;
  before: readonly T[];
  after: readonly T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  noun: string;
  /** Human phrases for what differs between two versions of the same item (empty when equal). */
  differences: (before: T, after: T) => string[];
  /** Optional extra qualifier for an added or removed item, for example "(required)". */
  qualifier?: (item: T, others: readonly T[]) => string;
}

function diffKeyed<T>(spec: KeyedSpec<T>): SkillDiffChange[] {
  const out: SkillDiffChange[] = [];
  const beforeByKey = new Map(spec.before.map((i) => [spec.keyOf(i), i]));
  const afterByKey = new Map(spec.after.map((i) => [spec.keyOf(i), i]));
  for (const item of spec.after) {
    const key = spec.keyOf(item);
    const previous = beforeByKey.get(key);
    const label = spec.labelOf(item);
    if (!previous) {
      out.push({
        section: spec.section,
        type: 'added',
        path: `${spec.path}[${key}]`,
        before: null,
        after: clip(label, 400),
        summary: `Added ${spec.noun}: ${label}${spec.qualifier ? spec.qualifier(item, spec.after) : ''}`,
      });
      continue;
    }
    const differences = spec.differences(previous, item);
    if (differences.length > 0) {
      out.push({
        section: spec.section,
        type: 'modified',
        path: `${spec.path}[${key}]`,
        before: clip(spec.labelOf(previous), 400),
        after: clip(label, 400),
        summary: `Changed ${spec.noun} “${label}”: ${differences.join('; ')}`,
      });
    }
  }
  for (const item of spec.before) {
    if (afterByKey.has(spec.keyOf(item))) continue;
    const label = spec.labelOf(item);
    out.push({
      section: spec.section,
      type: 'removed',
      path: `${spec.path}[${spec.keyOf(item)}]`,
      before: clip(label, 400),
      after: null,
      summary: `Removed ${spec.noun}: ${label}${spec.qualifier ? spec.qualifier(item, spec.before) : ''}`,
    });
  }
  return out;
}

/** The items of `source` that `other` does not account for (duplicates are counted). */
function surplus(source: readonly string[], other: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const text of other) available.set(text, (available.get(text) ?? 0) + 1);
  return source.filter((text) => {
    const left = available.get(text) ?? 0;
    if (left === 0) return true;
    available.set(text, left - 1);
    return false;
  });
}

function diffStrings(
  section: Section,
  path: string,
  noun: string,
  before: readonly string[],
  after: readonly string[],
): SkillDiffChange[] {
  const out: SkillDiffChange[] = [];
  for (const text of surplus(after, before)) {
    out.push({
      section,
      type: 'added',
      path: `${path}[+]`,
      before: null,
      after: text,
      summary: `Added ${noun}: ${clip(text, 200)}`,
    });
  }
  for (const text of surplus(before, after)) {
    out.push({
      section,
      type: 'removed',
      path: `${path}[-]`,
      before: text,
      after: null,
      summary: `Removed ${noun}: ${clip(text, 200)}`,
    });
  }
  return out;
}

function conditionDifferences(
  a: SkillContent['triggerConditions'][number],
  b: SkillContent['triggerConditions'][number],
): string[] {
  const out: string[] = [];
  if (a.weight !== b.weight) out.push(`weight ${a.weight} → ${b.weight}`);
  if (a.required !== b.required) out.push(b.required ? 'now required' : 'no longer required');
  if (a.description !== b.description) out.push('description updated');
  if (
    a.signalId !== b.signalId ||
    a.attribute !== b.attribute ||
    a.pattern !== b.pattern ||
    a.kind !== b.kind
  ) {
    out.push('matching rule updated');
  }
  return out;
}

function branchChanges(before: DecisionStep, after: DecisionStep): SkillDiffChange[] {
  const keyOf = (b: DecisionStep['branches'][number]): string => b.outcomeId ?? b.condition;
  return diffKeyed({
    section: 'decisionSequence',
    path: `decisionSequence[${after.id}].branches`,
    before: before.branches,
    after: after.branches,
    keyOf,
    labelOf: (b) => `${b.condition} → ${b.next}`,
    noun: `branch of step ${after.order}`,
    differences: (a, b) => {
      const out: string[] = [];
      if (a.next !== b.next) out.push(`goes to ${b.next} instead of ${a.next}`);
      if (a.probability !== b.probability) {
        out.push(`estimated probability ${show(a.probability)} → ${show(b.probability)}`);
      }
      if (a.hindsightProbability !== b.hindsightProbability) {
        out.push(
          `hindsight probability ${show(a.hindsightProbability)} → ${show(b.hindsightProbability)}`,
        );
      }
      if (a.rationale !== b.rationale && out.length === 0) out.push('rationale updated');
      return out;
    },
  });
}

function stepDifferences(a: DecisionStep, b: DecisionStep): string[] {
  const out: string[] = [];
  if (a.order !== b.order) out.push(`stage ${a.order} → ${b.order}`);
  if (a.title !== b.title) out.push('title updated');
  if (a.actionKey !== b.actionKey) out.push(`action ${show(a.actionKey)} → ${show(b.actionKey)}`);
  if (a.instruction !== b.instruction) out.push('instruction updated');
  if (a.expectedInformationGainBits !== b.expectedInformationGainBits)
    out.push('expected information gain updated');
  if (!same(a.requiresInputs, b.requiresInputs)) out.push('required inputs updated');
  return out;
}

/**
 * Human-readable, structured difference between two versions of one skill: added, removed and changed
 * trigger conditions, steps, branches, templates, constraints and metadata, each as a sentence.
 */
export function diffSkillVersions(input: {
  skillId: string;
  from: SkillVersion;
  to: SkillVersion;
}): SkillDiff {
  const a = input.from.content;
  const b = input.to.content;
  const changes: SkillDiffChange[] = [];

  for (const field of ['name', 'description', 'product', 'workload'] as const) {
    if (a[field] !== b[field]) {
      changes.push({
        section: 'overview',
        type: 'modified',
        path: field,
        before: clip(a[field], 400),
        after: clip(b[field], 400),
        summary: `Changed ${field}`,
      });
    }
  }
  changes.push(
    ...diffKeyed({
      section: 'triggerConditions',
      path: 'triggerConditions',
      before: a.triggerConditions,
      after: b.triggerConditions,
      keyOf: (c) => c.id,
      labelOf: (c) => c.description,
      noun: 'trigger condition',
      differences: conditionDifferences,
      qualifier: (c) => (c.required ? ' (required)' : ''),
    }),
    ...diffKeyed({
      section: 'exclusions',
      path: 'exclusions',
      before: a.exclusions,
      after: b.exclusions,
      keyOf: (c) => c.id,
      labelOf: (c) => c.description,
      noun: 'exclusion',
      differences: conditionDifferences,
    }),
    ...diffKeyed({
      section: 'requiredInputs',
      path: 'requiredInputs',
      before: a.requiredInputs,
      after: b.requiredInputs,
      keyOf: (i) => i.key,
      labelOf: (i) => i.label,
      noun: 'required input',
      differences: (x, y) => (same(x, y) ? [] : ['details updated']),
    }),
    ...diffKeyed({
      section: 'minimumEvidence',
      path: 'minimumEvidence',
      before: a.minimumEvidence,
      after: b.minimumEvidence,
      keyOf: (i) => i.requirementId,
      labelOf: (i) => i.label,
      noun: 'minimum-evidence item',
      differences: (x, y) => (same(x, y) ? [] : ['details updated']),
    }),
    ...diffKeyed({
      section: 'decisionSequence',
      path: 'decisionSequence',
      before: a.decisionSequence,
      after: b.decisionSequence,
      keyOf: (s) => s.id,
      labelOf: (s) => `${s.title}`,
      noun: 'step',
      differences: stepDifferences,
      qualifier: (s, all) =>
        all.filter((o) => o.order === s.order).length > 1
          ? ` (an alternative at stage ${s.order})`
          : ` (stage ${s.order})`,
    }),
  );
  for (const after of b.decisionSequence) {
    const before = a.decisionSequence.find((s) => s.id === after.id);
    if (before) changes.push(...branchChanges(before, after));
  }
  changes.push(
    ...diffKeyed({
      section: 'candidateActions',
      path: 'candidateActions',
      before: a.candidateActions,
      after: b.candidateActions,
      keyOf: (c) => c.actionKey,
      labelOf: (c) => c.label,
      noun: 'candidate action',
      differences: (x, y) => {
        const out: string[] = [];
        if (x.label !== y.label) out.push('label updated');
        if (x.whenToUse !== y.whenToUse) out.push('guidance on when to use it updated');
        if (x.risk !== y.risk || x.customerEffort !== y.customerEffort)
          out.push('risk or effort updated');
        if (x.requiresApproval !== y.requiresApproval) out.push('approval requirement updated');
        return out;
      },
    }),
    ...diffKeyed({
      section: 'queryTemplates',
      path: 'queryTemplates',
      before: a.queryTemplates,
      after: b.queryTemplates,
      keyOf: (t) => t.id,
      labelOf: (t) => `${t.title}`,
      noun: 'query template',
      differences: (x, y) => {
        const out: string[] = [];
        if (x.language !== y.language) out.push(`language ${x.language} → ${y.language}`);
        if (x.title !== y.title) out.push('title updated');
        if (x.description !== y.description) out.push('description updated');
        if (x.template !== y.template) out.push('template text updated');
        if (!same(x.parameters, y.parameters)) out.push('parameters updated');
        if (x.safetyNote !== y.safetyNote) out.push('safety note updated');
        return out;
      },
    }),
    ...diffStrings(
      'stopConditions',
      'stopConditions',
      'stop condition',
      a.stopConditions,
      b.stopConditions,
    ),
    ...diffStrings(
      'successConditions',
      'successConditions',
      'success condition',
      a.successConditions,
      b.successConditions,
    ),
    ...diffStrings(
      'escalationConditions',
      'escalationConditions',
      'escalation condition',
      a.escalationConditions,
      b.escalationConditions,
    ),
    ...diffStrings(
      'safetyConstraints',
      'safetyConstraints',
      'safety constraint',
      a.safetyConstraints,
      b.safetyConstraints,
    ),
    ...diffStrings(
      'knownFailureModes',
      'knownFailureModes',
      'known failure mode',
      a.knownFailureModes,
      b.knownFailureModes,
    ),
    ...diffStrings(
      'validationCriteria',
      'validationCriteria',
      'validation criterion',
      a.validationCriteria ?? [],
      b.validationCriteria ?? [],
    ),
    ...diffKeyed({
      section: 'sourceCases',
      path: 'sourceCases',
      before: a.sourceCases,
      after: b.sourceCases,
      keyOf: (s) => `${s.caseId}:${s.role}`,
      labelOf: (s) => `${s.reference} (${s.role.replace('_', ' ')})`,
      noun: 'source case',
      differences: (x, y) => (x.reference !== y.reference ? ['reference updated'] : []),
    }),
  );
  if (
    a.confidence.score !== b.confidence.score ||
    a.confidence.rationale !== b.confidence.rationale
  ) {
    changes.push({
      section: 'confidence',
      type: 'modified',
      path: 'confidence',
      before: `${a.confidence.score}`,
      after: `${b.confidence.score}`,
      summary:
        a.confidence.score !== b.confidence.score
          ? `Changed confidence estimate ${a.confidence.score} → ${b.confidence.score}`
          : 'Changed the confidence rationale',
    });
  }
  const optionalSummaries: Record<
    'applicability' | 'expectedBenefit' | 'provenance' | 'cheaperAlternatives',
    string
  > = {
    applicability:
      a.applicability &&
      b.applicability &&
      a.applicability.validatedOnCases !== b.applicability.validatedOnCases
        ? `Changed applicability notes (validated on ${a.applicability.validatedOnCases} → ${b.applicability.validatedOnCases} cases)`
        : 'Changed applicability notes',
    expectedBenefit: 'Changed the estimated benefit',
    provenance:
      'Changed provenance (the parts derived from hindsight or from decision-time information were extended)',
    cheaperAlternatives: 'Changed the cheaper alternatives',
  };
  for (const field of Object.keys(optionalSummaries) as (keyof typeof optionalSummaries)[]) {
    if (!same(a[field], b[field])) {
      changes.push({
        section: field,
        type: a[field] === undefined ? 'added' : b[field] === undefined ? 'removed' : 'modified',
        path: field,
        before: a[field] === undefined ? null : `${field} (previous)`,
        after: b[field] === undefined ? null : `${field} (current)`,
        summary: optionalSummaries[field],
      });
    }
  }

  return {
    skillId: input.skillId,
    fromVersion: input.from.version,
    toVersion: input.to.version,
    changes,
    summaryLines: [
      changes.length === 0
        ? `No content differences between ${input.from.version} and ${input.to.version}.`
        : `${changes.length} change${changes.length === 1 ? '' : 's'} between ${input.from.version} and ${input.to.version}.`,
      ...changes.map((c) => c.summary),
    ],
  };
}
