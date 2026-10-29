import { expect } from 'vitest';
import type { SkillVersion } from '@caseguard/schemas';
import {
  applySkillChangeSet,
  decideSkillVersion,
  proposeMutations,
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
  type MutationProposal,
  type SkillActor,
  type SkillAggregate,
  type SkillResult,
} from '../src';
import {
  ALEX,
  CASEY,
  ONE,
  REGRESSION_CASES,
  RILEY,
  TWO,
  makeOp,
  publishedAggregate,
  seeded,
  toReplayCase,
  versionOf,
} from './skills-fixtures';

/** The demo skill after real governance, and the Case Two mutation proposed against it. */
export const published = publishedAggregate();
export const v1 = versionOf(published);

export const errorOf = <T>(result: SkillResult<T>) => {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

export const valueOf = <T>(result: SkillResult<T>): T => {
  if (!result.ok) throw new Error(`expected success: ${result.error.message}`);
  return result.value;
};

export const proposalOf = (
  aggregate: SkillAggregate,
  actor: SkillActor = CASEY,
  seed = 'proposal',
): MutationProposal => {
  const result = proposeMutations({
    aggregate,
    source: seeded().mutationSource,
    actor,
    op: makeOp(seed),
  });
  if (!result.ok || result.value.status !== 'proposed') throw new Error('expected a proposal');
  return result.value.proposal;
};

/** Adds passed simulation and regression validations for one version, produced by the real functions. */
export const validated = (aggregate: SkillAggregate, version: SkillVersion): SkillAggregate => {
  const op = makeOp('validate');
  const simulation = runSkillSimulationTest({
    skill: aggregate.skill,
    version,
    cases: [toReplayCase(ONE), toReplayCase(TWO)],
  });
  const regression = runSkillRegressionSuite({
    skill: aggregate.skill,
    version,
    cases: REGRESSION_CASES,
  });
  expect([simulation.outcome, regression.outcome]).toEqual(['passed', 'passed']);
  return {
    ...aggregate,
    validations: [
      ...aggregate.validations,
      toSkillValidation({ report: simulation, op, executedBy: RILEY.id }),
      toSkillValidation({ report: regression, op, executedBy: RILEY.id }),
    ],
  };
};

export const proposal = proposalOf(published);
export const proposed = applySkillChangeSet(published, proposal.changeSet);
export const ready = validated(proposed, proposal.version);

export const decide = (
  aggregate: SkillAggregate,
  decision: 'approve' | 'reject',
  actor: SkillActor = ALEX,
  expectedVersion = aggregate.skill.version,
) =>
  decideSkillVersion({
    aggregate,
    versionId: proposal.version.id,
    request: { decision, reason: 'Reviewed the diff.', expectedVersion },
    actor,
    op: makeOp('decide'),
  });

export const approved = applySkillChangeSet(ready, valueOf(decide(ready, 'approve')));
