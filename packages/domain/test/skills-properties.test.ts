import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SKILL_LIFECYCLE,
  SkillDiffSchema,
  type SkillContent,
  type SkillLifecycle,
  type SkillValidation,
} from '@caseguard/schemas';
import {
  MATCHABLE_LIFECYCLES,
  SKILL_TRANSITIONS,
  applySkillChangeSet,
  diffSkillVersions,
  hashJson,
  pilotApproversOf,
  transitionRule,
  transitionSkill,
  validationShortfall,
  currentVersionOf,
  type SkillActor,
  type SkillAggregate,
} from '../src';
import {
  ALEX,
  AVA,
  CASEY,
  MORGAN,
  RILEY,
  SYSTEM_BOT,
  TWO,
  asOf,
  draftAggregate,
  makeOp,
  matchAt,
  versionOf,
  validationOf,
  withPoisonedFuture,
  withoutFuture,
} from './skills-fixtures';

const POOL: readonly SkillActor[] = [AVA, RILEY, CASEY, ALEX, MORGAN, SYSTEM_BOT];
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('Expected a non-empty list');
  return item;
};

describe('the lifecycle graph', () => {
  it('[FR-SK-02] has the nine states, a terminal Retired and Published reachable only from Validated', () => {
    expect(SKILL_LIFECYCLE).toEqual([
      'discovered',
      'draft',
      'simulation_tested',
      'expert_reviewed',
      'pilot',
      'validated',
      'published',
      'deprecated',
      'retired',
    ]);
    expect(SKILL_TRANSITIONS.retired).toEqual([]);
    const into = (to: SkillLifecycle) =>
      SKILL_LIFECYCLE.filter((from) => SKILL_TRANSITIONS[from].includes(to));
    expect(into('published')).toEqual(['validated']);
    expect(into('discovered')).toEqual([]);
    expect(into('pilot')).toEqual(['expert_reviewed']);
  });

  it('[FR-SK-02] every state is reachable from Discovered and every edge has a rule with a permission', () => {
    const seen = new Set<SkillLifecycle>(['discovered']);
    const queue: SkillLifecycle[] = ['discovered'];
    for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
      for (const next of SKILL_TRANSITIONS[state]) {
        expect(transitionRule(state, next), `${state} -> ${next}`).not.toBeNull();
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...SKILL_LIFECYCLE].sort());
  });

  it('[FR-SK-03] publication always demands a distinct person, and only matchable states are ever suggested', () => {
    expect(transitionRule('validated', 'published')).toMatchObject({
      permission: 'skill:publish',
      distinctFromCreator: true,
      distinctFromApprovers: true,
    });
    expect(
      MATCHABLE_LIFECYCLES.every(
        (l) => !['deprecated', 'retired', 'discovered', 'draft'].includes(l),
      ),
    ).toBe(true);
  });
});

interface WalkStep {
  pick: number;
  actor: number;
  smart: number;
  evidence: number;
  stale: number;
}
const walkStep = fc.record({
  pick: fc.nat(7),
  actor: fc.nat(POOL.length - 1),
  smart: fc.nat(3),
  evidence: fc.nat(7),
  stale: fc.nat(7),
});

// The person who would normally take each step; walks use them most of the time so publication is reachable.
const ROLE: Partial<Record<SkillLifecycle, SkillActor>> = {
  draft: AVA,
  simulation_tested: RILEY,
  expert_reviewed: RILEY,
  pilot: CASEY,
  validated: RILEY,
  published: ALEX,
  deprecated: CASEY,
  retired: CASEY,
};
const EVIDENCE_CODES = [0, 3, 3, 3, 1, 2, 4, 5] as const;

function evidence(aggregate: SkillAggregate, code: number, when: string): SkillValidation[] {
  const sim = (outcome: SkillValidation['outcome']) =>
    validationOf(aggregate, 'simulation_test', outcome, when);
  const reg = (outcome: SkillValidation['outcome']) =>
    validationOf(aggregate, 'regression', outcome, when);
  switch (code) {
    case 1:
      return [sim('passed')];
    case 2:
      return [reg('passed')];
    case 3:
      return [sim('passed'), reg('passed')];
    case 4:
      return [sim('failed')];
    case 5:
      return [reg('failed')];
    default:
      return [];
  }
}

function actorFor(step: WalkStep, to: SkillLifecycle): SkillActor {
  if (step.smart === 0) return at(POOL, step.actor);
  // A quarter of planned publications are attempted by the pilot approver, who may not publish.
  if (to === 'published' && step.smart === 1) return CASEY;
  return ROLE[to] ?? at(POOL, step.actor);
}

const tally = { published: 0, transitions: 0, codes: new Set<string>() };

/** Walks a skill through random attempts; every invariant is checked at the moment it could be broken. */
function walk(steps: readonly WalkStep[]): SkillAggregate {
  let aggregate = draftAggregate();
  const initialVersion = aggregate.skill.version;
  let successes = 0;
  steps.forEach((step, index) => {
    const when = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
    aggregate = {
      ...aggregate,
      validations: [
        ...aggregate.validations,
        ...evidence(aggregate, at(EVIDENCE_CODES, step.evidence), when),
      ],
    };
    const legal = SKILL_TRANSITIONS[aggregate.skill.lifecycle];
    if (legal.length === 0) return;
    const to = step.pick === 0 ? at(legal, index) : at(legal, 0);
    const actor = actorFor(step, to);
    const stale = step.stale === 0;
    const before = structuredClone(aggregate);
    const expectedVersion = stale ? aggregate.skill.version + 1 : aggregate.skill.version;
    const result = transitionSkill({
      aggregate,
      request: { toState: to, reason: 'Property-based move.', expectedVersion },
      actor,
      op: makeOp(`walk-${index}`),
    });
    expect(aggregate).toEqual(before);
    if (!result.ok) {
      tally.codes.add(result.error.code);
      expect(result.error.audit, 'every refusal is audited').not.toBeNull();
      if (actor.kind === 'system') expect(result.error.code).toBe('forbidden');
      return;
    }
    expect(stale, 'a stale version never succeeds').toBe(false);
    expect(actor.kind, 'automated actors never move a skill').not.toBe('system');
    const change = result.value;
    const from = aggregate.skill.lifecycle;
    expect(SKILL_TRANSITIONS[from]).toContain(change.skill.lifecycle);
    expect(from).not.toBe('retired');
    expect(actor.permissions).toContain(transitionRule(from, change.skill.lifecycle)?.permission);
    expect(change.previousSkillVersion).toBe(aggregate.skill.version);
    expect(change.skill.version).toBe(aggregate.skill.version + 1);
    expect(change.audit).toHaveLength(1);
    expect(change.approvals[0]).toMatchObject({
      fromState: from,
      toState: change.skill.lifecycle,
      approver: actor.id,
    });
    const version = versionOf(aggregate);
    const needs = (kinds: ('simulation_test' | 'regression')[]) =>
      expect(validationShortfall(aggregate, version, kinds)).toBeNull();
    switch (change.skill.lifecycle) {
      case 'simulation_tested':
        needs(['simulation_test']);
        break;
      case 'expert_reviewed':
      case 'pilot':
        expect(actor.id).not.toBe(aggregate.skill.createdBy);
        needs(['simulation_test']);
        break;
      case 'validated':
        needs(['simulation_test', 'regression']);
        break;
      case 'published': {
        const approvers = pilotApproversOf(aggregate);
        expect(approvers.length, 'a pilot approval is on record').toBeGreaterThan(0);
        expect(approvers).not.toContain(actor.id);
        expect(actor.id).not.toBe(aggregate.skill.createdBy);
        expect(approvers).not.toContain(aggregate.skill.createdBy);
        needs(['simulation_test', 'regression']);
        tally.published += 1;
        break;
      }
      default:
        break;
    }
    aggregate = applySkillChangeSet(aggregate, change);
    successes += 1;
    tally.transitions += 1;
    expect(aggregate.skill.version).toBe(initialVersion + successes);
  });
  return aggregate;
}

describe('state machine invariants under random attempts', () => {
  it('[FR-SK-03] published always has a distinct creator, approver and publisher and passed validations; nothing ever skips a gate', () => {
    fc.assert(
      fc.property(fc.array(walkStep, { minLength: 1, maxLength: 60 }), (steps) => void walk(steps)),
      { numRuns: 120, seed: 20261031 },
    );
    expect(tally.published, 'the walks must actually reach publication').toBeGreaterThan(0);
    expect([...tally.codes]).toEqual(
      expect.arrayContaining([
        'forbidden',
        'gate_failed',
        'version_conflict',
        'separation_of_duties',
      ]),
    );
  }, 60_000);

  it('[FR-SK-02] is deterministic: the same attempts always end in the same skill', () => {
    fc.assert(
      fc.property(fc.array(walkStep, { maxLength: 40 }), (steps) => {
        expect(walk(steps)).toEqual(walk(steps));
      }),
      { numRuns: 30, seed: 20261101 },
    );
  }, 60_000);

  it('[FR-SK-03] a skill is never published without a person who holds the publish permission', () => {
    fc.assert(
      fc.property(fc.array(walkStep, { minLength: 1, maxLength: 60 }), (steps) => {
        const end = walk(steps);
        for (const approval of end.approvals.filter((a) => a.toState === 'published')) {
          const person = POOL.find((p) => p.id === approval.approver);
          expect(person?.kind).not.toBe('system');
          expect(person?.permissions).toContain('skill:publish');
        }
      }),
      { numRuns: 60, seed: 20261102 },
    );
  }, 60_000);
});

describe('matching is strictly as of the match time', () => {
  const suffixes = [
    'g01',
    'g02',
    'g03',
    'g04',
    'g05',
    'g06',
    'g07',
    'g08',
    'g09',
    'g10',
    'g11',
    'g12',
    'g13',
    'g14',
    'g15',
  ] as const;

  it('[FR-SK-05] for every instant of Case Two, rewriting or deleting the future never changes the decision', () => {
    fc.assert(
      fc.property(fc.constantFrom(...suffixes), (suffix) => {
        const t = asOf(TWO, suffix);
        const expected = matchAt(TWO, t);
        expect(matchAt(TWO, t, undefined, withPoisonedFuture(TWO, t))).toEqual(expected);
        expect(matchAt(TWO, t, undefined, withoutFuture(TWO, t))).toEqual(expected);
      }),
      { numRuns: 30, seed: 20261103 },
    );
  });
});

const EDITS: ((c: SkillContent, text: string, n: number) => void)[] = [
  (c, t) => void c.safetyConstraints.push(t),
  (c, _t, n) => void c.stopConditions.splice(n % Math.max(1, c.stopConditions.length), 1),
  (c, _t, n) => void (c.confidence = { ...c.confidence, score: (n % 101) / 100 }),
  (c, t) => void (c.description = t),
  (c, _t, n) => void (at(c.triggerConditions, n).weight = (n % 11) / 10),
  (c, _t, n) => void (at(c.triggerConditions, n).required = !at(c.triggerConditions, n).required),
  (c, t, n) => void (at(c.decisionSequence, n).instruction = t),
  (c, t) => void (at(c.queryTemplates, 0).safetyNote = t.slice(0, 300)),
  (c, _t, n) => void (at(at(c.decisionSequence, n).branches, 0).probability = (n % 101) / 100),
  (c, _t, n) => void c.candidateActions.splice(n % Math.max(1, c.candidateActions.length), 1),
  (c, t, n) => void (at(c.candidateActions, n).label = t.slice(0, 160)),
  (c, t) => void c.knownFailureModes.push(t),
  (c, t, n) => void (at(c.sourceCases, n).reference = t.slice(0, 100)),
  (c, _t, n) => void (at(c.decisionSequence, n).expectedInformationGainBits = (n % 50) / 10),
  (c, t) =>
    void (c.exclusions = c.exclusions.map((e, i) =>
      i === 0 ? { ...e, description: t.slice(0, 400) } : e,
    )),
  (c, t) => void c.escalationConditions.push(t),
];

describe('version diff properties', () => {
  const v1 = versionOf(draftAggregate());

  it('[FR-SK-04] a diff is empty exactly when the content is identical, and always satisfies the contract', () => {
    const edit = fc.record({
      edit: fc.nat(EDITS.length - 1),
      text: fc.string({ minLength: 1, maxLength: 60 }),
      n: fc.nat(1000),
    });
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 8 }), (edits) => {
        const content = structuredClone(v1.content);
        for (const e of edits) at(EDITS, e.edit)(content, e.text, e.n);
        const to = {
          ...v1,
          id: 'skv_property',
          version: '1.0.1',
          content,
          contentHash: hashJson(content),
        };
        const diff = diffSkillVersions({ skillId: v1.skillId, from: v1, to });
        expect(diff.changes.length === 0).toBe(hashJson(content) === hashJson(v1.content));
        expect(SkillDiffSchema.safeParse(diff).success).toBe(true);
        const back = diffSkillVersions({ skillId: v1.skillId, from: to, to: v1 });
        expect(back.changes).toHaveLength(diff.changes.length);
        expect(diff.changes.filter((c) => c.type === 'added')).toHaveLength(
          back.changes.filter((c) => c.type === 'removed').length,
        );
      }),
      { numRuns: 150, seed: 20261104 },
    );
  }, 60_000);

  it('[FR-SK-04] reads the current version from the aggregate it describes', () => {
    expect(currentVersionOf(draftAggregate())?.id).toBe(v1.id);
  });
});
