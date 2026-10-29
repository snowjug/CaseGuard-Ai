import type { DecisionStep, SkillContent, SkillDiff, SkillVersion } from '@caseguard/schemas';
import { resolutionHypothesisKey } from '../engine/hindsight';
import { createTemporalViewBeforeEvent } from '../engine/temporal';
import { hashJson, stableId } from '../util/ids';
import { round } from '../util/math';
import { auditPayload, refusal } from './audit';
import {
  buildCandidateAction,
  buildCondition,
  buildDecisionStep,
  stepIdFor,
  successConditionOf,
  type BranchContext,
} from './content-builders';
import { diffSkillVersions } from './diff';
import { deriveTriggers, exclusionSignalIds, familyOf } from './ladder';
import {
  breaksPremise,
  confirmingActions,
  decisionEventOf,
  type MutationSourceCase,
} from './mutation-support';
import { knowledgeStateFromView } from './state';
import { templatesOfAction } from './templates';
import {
  currentVersionOf,
  skillOk,
  type SkillActor,
  type SkillAggregate,
  type SkillChangeSet,
  type SkillErrorCode,
  type SkillOpContext,
  type SkillResult,
} from './types';
import { bumpSemver, clip, compareSemver } from './util';

export type { MutationSourceCase } from './mutation-support';

export type MutationKind =
  | 'add_trigger'
  | 'add_step'
  | 'promote_alternative'
  | 'add_query_template'
  | 'add_failure_mode'
  | 'add_success_condition'
  | 'add_source_case'
  | 'update_confidence';

export interface MutationItem {
  kind: MutationKind;
  summary: string;
  evidenceSignalIds: string[];
  sourceEventIds: string[];
  /** True when the item relies on the recorded root cause of the source case. */
  usesHindsight: boolean;
}

export interface MutationProposal {
  version: SkillVersion;
  changeSet: SkillChangeSet;
  diff: SkillDiff;
  mutations: MutationItem[];
  notices: string[];
}

export type MutationOutcome =
  { status: 'proposed'; proposal: MutationProposal } | { status: 'no_change'; reasons: string[] };

export interface ProposeMutationsInput {
  aggregate: SkillAggregate;
  source: MutationSourceCase;
  actor: SkillActor;
  op: SkillOpContext;
  /** Optional optimistic lock on the skill row. */
  expectedVersion?: number;
}

const highestVersion = (versions: readonly SkillVersion[]): string =>
  [...versions].sort((a, b) => compareSemver(b.version, a.version))[0]?.version ?? '1.0.0';

/**
 * Proposes a new skill version learned from another completed case, for example the proxy-node branch,
 * timeout trigger and per-node timing template that a proxy-caused case adds to a DNS-derived skill.
 * The result is a `proposed` version that a distinct approver must review: nothing is ever applied.
 */
export function proposeMutations(input: ProposeMutationsInput): SkillResult<MutationOutcome> {
  const { aggregate, source, actor, op } = input;
  const { skill } = aggregate;
  const fail = (code: SkillErrorCode, message: string, details?: Record<string, unknown>) =>
    refusal<MutationOutcome>({
      code,
      message,
      action: 'skill.mutation',
      targetType: 'skill',
      targetId: skill.id,
      actorId: actor.id,
      now: op.now,
      caseId: source.caseId,
      ...(details ? { details } : {}),
    });

  if (!actor.permissions.includes('skill:mutate')) {
    return fail('forbidden', 'Proposing a mutation requires the skill:mutate permission.');
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== skill.version) {
    return fail('version_conflict', 'The skill was changed by someone else. Reload and retry.', {
      expected: input.expectedVersion,
      actual: skill.version,
    });
  }
  if (skill.lifecycle === 'retired' || skill.lifecycle === 'deprecated') {
    return fail('conflict', `A ${skill.lifecycle} skill cannot be mutated.`);
  }
  const base = currentVersionOf(aggregate);
  if (!base) return fail('not_found', 'The current version of the skill was not found.');
  if (source.caseInfo.workload !== skill.workload) {
    return fail(
      'validation_failed',
      'The source case belongs to a different workload than the skill.',
    );
  }
  if (skill.sourceCaseIds.includes(source.caseId)) {
    return skillOk({
      status: 'no_change',
      reasons: ['This case is already a source case of the skill.'],
    });
  }
  const { pack, analysis, resolution } = source;
  const truth = resolutionHypothesisKey(resolution, pack);
  if (!resolution || !truth || resolution.validation?.outcome !== 'confirmed') {
    return fail(
      'validation_failed',
      'Only a resolved case with a validated root cause that maps to the knowledge pack can propose a mutation.',
    );
  }
  const decisionEventId = decisionEventOf(analysis);
  if (!decisionEventId) {
    return skillOk({
      status: 'no_change',
      reasons: ['The source case recorded no investigation steps to learn from.'],
    });
  }

  const content: SkillContent = structuredClone(base.content);
  const items: MutationItem[] = [];
  const hindsightParts: string[] = [];
  const decisionParts: string[] = [];
  const preView = createTemporalViewBeforeEvent(source.events, decisionEventId);
  const { state: state0 } = knowledgeStateFromView(preView, pack, source.ctx.caseId);
  const family = familyOf(pack, truth);
  const knownSignals = new Set(
    [...content.triggerConditions, ...content.exclusions]
      .map((c) => c.signalId)
      .filter((s): s is string => s !== undefined),
  );
  const eventsOf = (signalId: string): string[] =>
    [
      ...new Set(
        analysis.observations.filter((o) => o.signalId === signalId).map((o) => o.eventId),
      ),
    ].slice(0, 5);

  // 1. Trigger conditions the new case shows at its decision time that the skill does not know yet.
  const firstActionKey = analysis.actions[0]?.actionKey;
  const firstStepSignals = new Set(
    (firstActionKey ? pack.actions.get(firstActionKey)?.outcomes : [])?.flatMap(
      (o) => o.emitsSignals,
    ) ?? [],
  );
  const specs = deriveTriggers({
    pack,
    family,
    truth,
    observedAtDecision: state0.observedSignals,
    firstStepSignals,
  }).filter((t) => !knownSignals.has(t.signalId));
  const optionalWeights = content.triggerConditions.filter((c) => !c.required).map((c) => c.weight);
  const newWeight = round(
    optionalWeights.length > 0
      ? optionalWeights.reduce((s, w) => s + w, 0) / optionalWeights.length
      : 0.15,
    3,
  );
  for (const spec of specs) {
    const signal = pack.signals.get(spec.signalId);
    if (!signal) continue;
    const condition = buildCondition(signal, 'trg', newWeight, false);
    content.triggerConditions.push({
      ...condition,
      description: clip(`${condition.description} (added from ${source.reference})`, 400),
    });
    items.push({
      kind: 'add_trigger',
      summary: `Add trigger condition “${signal.label}” (seen at the decision time of ${source.reference}).`,
      evidenceSignalIds: [spec.signalId],
      sourceEventIds: eventsOf(spec.signalId),
      usesHindsight: spec.origin === 'hindsight',
    });
    (spec.origin === 'hindsight' ? hindsightParts : decisionParts).push(
      `triggerConditions.${condition.id}`,
    );
  }

  // 2. The check that confirmed the recorded cause: promote it to a validated step, with its template.
  const exclusionSet = new Set([
    ...content.exclusions.map((c) => c.signalId).filter((s): s is string => s !== undefined),
    ...exclusionSignalIds(pack, family),
  ]);
  const branchCtx: BranchContext = {
    pack,
    belief0: state0.belief,
    truth,
    exclusionSignals: exclusionSet,
  };
  for (const action of confirmingActions(source, truth)) {
    if (content.decisionSequence.some((s) => s.actionKey === action.id)) continue;
    const hostStep = content.decisionSequence.find((s) => {
      const hostAction = s.actionKey ? pack.actions.get(s.actionKey) : undefined;
      return hostAction?.produces.some((r) => action.produces.includes(r)) ?? false;
    });
    const maxOrder = Math.max(...content.decisionSequence.map((s) => s.order));
    const order = hostStep ? hostStep.order : maxOrder + 1;
    const step: DecisionStep = buildDecisionStep({
      action,
      order,
      nextStepId: null,
      role: 'terminal',
      ctx: branchCtx,
    });
    if (!hostStep) {
      const previous = content.decisionSequence.find((s) => s.order === maxOrder);
      if (previous) {
        previous.branches = previous.branches.map((b) =>
          b.next === 'stop' && !breaksPremise(pack, previous, b.outcomeId, exclusionSet)
            ? {
                ...b,
                next: step.id,
                rationale: clip(
                  `Continue with the check validated by ${source.reference}. ${b.rationale}`,
                  400,
                ),
              }
            : b,
        );
      }
    }
    content.decisionSequence.push(step);
    const existing = content.candidateActions.find((c) => c.actionKey === action.id);
    const whenToUse = `Stage ${order}: validated by ${source.reference}; prefer it when the evidence points at ${family.map((h) => pack.hypotheses.get(h)?.name ?? h).join(' or ')}.`;
    if (existing) existing.whenToUse = clip(whenToUse, 300);
    else content.candidateActions.push(buildCandidateAction(action, whenToUse));
    items.push({
      kind: existing ? 'promote_alternative' : 'add_step',
      summary: `${existing ? 'Promote' : 'Add'} the step “${action.label}” (${order === maxOrder + 1 ? 'a new final stage' : `an alternative at stage ${order}`}), validated by ${source.reference}.`,
      evidenceSignalIds: action.outcomes
        .flatMap((o) => o.emitsSignals)
        .filter(
          (s) =>
            state0.observedSignals.has(s) || analysis.observations.some((o) => o.signalId === s),
        ),
      sourceEventIds: analysis.actions
        .filter((a) => a.actionKey === action.id)
        .map((a) => a.eventId),
      usesHindsight: true,
    });
    hindsightParts.push(`decisionSequence.${stepIdFor(order, action.id)}`);
    for (const template of templatesOfAction(action)) {
      if (content.queryTemplates.some((t) => t.id === template.id)) continue;
      content.queryTemplates.push(template);
      items.push({
        kind: 'add_query_template',
        summary: `Add the ${template.language === 'powershell' ? 'PowerShell' : 'KQL'} template “${template.title}”.`,
        evidenceSignalIds: [],
        sourceEventIds: [],
        usesHindsight: false,
      });
      decisionParts.push(`queryTemplates.${template.id}`);
    }
    const success = successConditionOf(pack, action, truth);
    if (success && !content.successConditions.includes(success)) {
      content.successConditions.push(success);
      items.push({
        kind: 'add_success_condition',
        summary: `Add the success condition for “${action.label}”.`,
        evidenceSignalIds: [],
        sourceEventIds: [],
        usesHindsight: true,
      });
      hindsightParts.push('successConditions');
    }
  }

  if (items.length === 0) {
    return skillOk({
      status: 'no_change',
      reasons: [`${source.reference} confirms nothing the skill does not already cover.`],
    });
  }

  // 3. A failure mode, the new source case and an honest confidence update.
  const hypothesis = pack.hypotheses.get(truth);
  const failureMode = clip(
    `${hypothesis?.name ?? truth}: ${hypothesis?.description ?? ''} (${source.reference})`,
    300,
  );
  if (!content.knownFailureModes.includes(failureMode)) {
    content.knownFailureModes.push(failureMode);
    items.push({
      kind: 'add_failure_mode',
      summary: `Add the failure mode “${hypothesis?.name ?? truth}”.`,
      evidenceSignalIds: [],
      sourceEventIds: [],
      usesHindsight: true,
    });
    hindsightParts.push('knownFailureModes');
  }
  content.sourceCases.push({
    caseId: source.caseId,
    reference: clip(`${source.reference} · mutation source · run ${source.ctx.runId}`, 200),
    role: 'mutation_source',
  });
  items.push({
    kind: 'add_source_case',
    summary: `Record ${source.reference} as a mutation source.`,
    evidenceSignalIds: [],
    sourceEventIds: [],
    usesHindsight: false,
  });
  const caseCount = content.sourceCases.length;
  const confidence = round(Math.min(0.75, content.confidence.score + 0.1), 2);
  content.confidence = {
    score: confidence,
    rationale: clip(
      `Model estimate, not a measurement: supported by ${caseCount} source cases (${content.sourceCases.map((s) => s.reference.split(' · ')[0]).join(', ')}); capped at 75% until it is validated on more cases.`,
      500,
    ),
  };
  items.push({
    kind: 'update_confidence',
    summary: `Raise the confidence estimate to ${Math.round(confidence * 100)}% (${caseCount} source cases).`,
    evidenceSignalIds: [],
    sourceEventIds: [],
    usesHindsight: false,
  });
  if (content.applicability) {
    content.applicability = {
      ...content.applicability,
      validatedOnCases: caseCount,
      limitations: [
        `Supported by ${caseCount} ${source.synthetic ? 'synthetic ' : ''}source cases; it has not been validated on other cases.`,
        ...content.applicability.limitations.filter(
          (l) => !l.startsWith('Distilled from one') && !l.startsWith('Same-question alternatives'),
        ),
      ],
    };
  }
  if (content.provenance) {
    content.provenance = {
      ...content.provenance,
      hindsight: {
        ...content.provenance.hindsight,
        parts: [...new Set([...content.provenance.hindsight.parts, ...hindsightParts])],
      },
      decisionTimeParts: [...new Set([...content.provenance.decisionTimeParts, ...decisionParts])],
    };
  }

  const contentHash = hashJson(content);
  const versionId = stableId('skv', skill.id, 'mutation', source.caseId, base.id);
  if (aggregate.versions.some((v) => v.id === versionId)) {
    return fail('conflict', 'This mutation has already been proposed for the current version.', {
      existingVersionId: versionId,
    });
  }
  const version: SkillVersion = {
    tenantId: op.tenantId,
    createdAt: op.now,
    updatedAt: op.now,
    createdBy: actor.id,
    id: versionId,
    skillId: skill.id,
    version: bumpSemver(highestVersion(aggregate.versions), 'minor'),
    sequence: Math.max(...aggregate.versions.map((v) => v.sequence)) + 1,
    parentVersionId: base.id,
    changeType: 'mutation',
    changeSummary: clip(
      `Proposed from ${source.reference}: ${items
        .filter((i) => i.kind !== 'add_source_case' && i.kind !== 'update_confidence')
        .map((i) => i.summary)
        .join(' ')}`,
      600,
    ),
    state: 'proposed',
    lifecycleAtCreation: skill.lifecycle,
    content,
    contentHash,
  };
  const changeSet: SkillChangeSet = {
    skill: { ...skill, hasProposedMutation: true, updatedAt: op.now, version: skill.version + 1 },
    previousSkillVersion: skill.version,
    newVersions: [version],
    versionStates: [],
    validations: [],
    approvals: [],
    audit: [
      auditPayload({
        action: 'skill.mutation_proposed',
        targetType: 'skill_version',
        targetId: versionId,
        actorId: actor.id,
        now: op.now,
        outcome: 'success',
        caseId: source.caseId,
        details: {
          skillId: skill.id,
          baseVersionId: base.id,
          proposedVersion: version.version,
          mutationKinds: [...new Set(items.map((i) => i.kind))],
          sourceCaseReference: source.reference,
          usedRecordedResolution: true,
        },
      }),
    ],
  };
  return skillOk({
    status: 'proposed',
    proposal: {
      version,
      changeSet,
      diff: diffSkillVersions({ skillId: skill.id, from: base, to: version }),
      mutations: items,
      notices: [
        'A proposed mutation is never applied automatically: a distinct approver must review the diff.',
        `The proposal uses the recorded resolution of ${source.reference} (hindsight) to extend the skill; it is a model-assisted suggestion, not a validated fact.`,
        'Run the simulation test and the regression suite on the proposed version before approving it.',
      ],
    },
  });
}
