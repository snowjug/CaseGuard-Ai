import type { SkillLifecycle } from '@caseguard/schemas';
import { transitionSkill } from './lifecycle';
import {
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
  type ReplayCaseInput,
  type SkillReplayCase,
} from './simulation';
import {
  applySkillChangeSet,
  currentVersionOf,
  skillFail,
  skillOk,
  type SkillActor,
  type SkillAggregate,
  type SkillOpContext,
  type SkillResult,
} from './types';

/** The people (or personas) who take each governance step; publication needs two others. */
export interface GovernanceCast {
  drafter: SkillActor;
  validator: SkillActor;
  reviewer: SkillActor;
  approver: SkillActor;
  publisher: SkillActor;
}

const FORWARD: readonly SkillLifecycle[] = [
  'discovered',
  'draft',
  'simulation_tested',
  'expert_reviewed',
  'pilot',
  'validated',
  'published',
];

/**
 * Walks a skill forward through the REAL gates (simulation test, expert review, pilot approval,
 * regression, publication) with the given cast. Nothing is bypassed: an actor without the permission,
 * a failed test or a repeated person stops the walk with the same typed error the API would return.
 * The demo seed uses it so seeded skills reach `published` only the way a real one would.
 */
export function advanceSkillGovernance(args: {
  aggregate: SkillAggregate;
  cast: GovernanceCast;
  op: SkillOpContext;
  simulationCases: readonly SkillReplayCase[];
  regressionCases: readonly ReplayCaseInput[];
  target: SkillLifecycle;
}): SkillResult<SkillAggregate> {
  const { cast, op, target } = args;
  let aggregate = args.aggregate;
  const targetIndex = FORWARD.indexOf(target);
  if (targetIndex < 0) {
    return skillFail('illegal_transition', `${target} is not a forward lifecycle state.`);
  }
  const step = (
    to: SkillLifecycle,
    actor: SkillActor,
    reason: string,
  ): SkillResult<SkillAggregate> => {
    const moved = transitionSkill({
      aggregate,
      request: { toState: to, reason, expectedVersion: aggregate.skill.version },
      actor,
      op,
    });
    if (!moved.ok) return moved;
    aggregate = applySkillChangeSet(aggregate, moved.value);
    return skillOk(aggregate);
  };
  const validate = (kind: 'simulation_test' | 'regression'): SkillResult<SkillAggregate> => {
    const version = currentVersionOf(aggregate);
    if (!version) return skillFail('not_found', 'The current version of the skill was not found.');
    const report =
      kind === 'simulation_test'
        ? runSkillSimulationTest({ skill: aggregate.skill, version, cases: args.simulationCases })
        : runSkillRegressionSuite({ skill: aggregate.skill, version, cases: args.regressionCases });
    aggregate = {
      ...aggregate,
      validations: [
        ...aggregate.validations,
        toSkillValidation({ report, op, executedBy: cast.validator.id }),
      ],
    };
    return skillOk(aggregate);
  };

  const plan: {
    to: SkillLifecycle;
    actor: SkillActor;
    reason: string;
    before?: () => SkillResult<SkillAggregate>;
  }[] = [
    { to: 'draft', actor: cast.drafter, reason: 'Adopted by the drafter for review.' },
    {
      to: 'simulation_tested',
      actor: cast.validator,
      reason: 'The simulation test passed on the source case.',
      before: () => validate('simulation_test'),
    },
    {
      to: 'expert_reviewed',
      actor: cast.reviewer,
      reason: 'Reviewed the steps, safety notes and branches.',
    },
    { to: 'pilot', actor: cast.approver, reason: 'Approved for a pilot on live cases.' },
    {
      to: 'validated',
      actor: cast.validator,
      reason: 'The regression suite passed across the related cases.',
      before: () => validate('regression'),
    },
    { to: 'published', actor: cast.publisher, reason: 'Published for general use after approval.' },
  ];
  const from = FORWARD.indexOf(aggregate.skill.lifecycle);
  for (const move of plan) {
    const index = FORWARD.indexOf(move.to);
    if (index <= from || index > targetIndex) continue;
    if (move.before) {
      const checked = move.before();
      if (!checked.ok) return checked;
    }
    const result = step(move.to, move.actor, move.reason);
    if (!result.ok) return result;
  }
  return skillOk(aggregate);
}
