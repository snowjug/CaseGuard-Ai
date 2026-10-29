import {
  CaseBundleSchema,
  type CaseBundle,
  type Permission,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import {
  advanceSkillGovernance,
  createFullView,
  createSkillIdGenerator,
  currentVersionOf,
  deriveSeedSkills,
  matchSkills,
  type AnalysisAsOf,
  type CaseInfo,
  type GovernanceCast,
  type MatchableSkill,
  type MutationSourceCase,
  type SeedSkills,
  type SkillActor,
  type SkillAggregate,
  type SkillMatchSet,
  type SkillReplayCase,
} from '../src';
import {
  CASE_ONE,
  CASE_TWO,
  CONFIG,
  NOW,
  loadBundle,
  prepareBundle,
  type Prepared,
} from './helpers';

/** Distinct case ids: the shared helpers default both cases to the same id. */
export const ONE = prepareBundle(loadBundle(CASE_ONE), 'case_syn_1001');
export const TWO = prepareBundle(loadBundle(CASE_TWO), 'case_syn_1002');

const IRRELEVANT_BUNDLE: CaseBundle = CaseBundleSchema.parse({
  schemaVersion: 'caseguard.case-bundle/1',
  synthetic: true,
  syntheticNotice: 'SYNTHETIC DEMONSTRATION DATA authored for the skill regression tests.',
  case: {
    reference: 'CG-SYN-9001',
    title: 'One laptop cannot sign in to Teams, fixed by clearing the cache',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'C',
    status: 'resolved',
    openedAt: '2026-05-04T08:00:00Z',
    customerAlias: 'Adatum Synthetic',
    tags: ['synthetic', 'single-device'],
  },
  participants: [
    { id: 'p-user', role: 'customer_end_user', alias: 'End User 1' },
    { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 3' },
  ],
  events: [
    {
      id: 'x01',
      timestamp: '2026-05-04T08:00:00Z',
      participantId: 'p-user',
      type: 'customer_email',
      channel: 'email',
      title: 'Teams will not sign in on my laptop',
      body: 'Hello, only one user is affected: my laptop cannot sign in to Teams since this morning. My colleagues sign in without problems. It fails every time.',
    },
    {
      id: 'x02',
      timestamp: '2026-05-04T08:20:00Z',
      participantId: 'p-eng',
      type: 'engineer_email',
      channel: 'email',
      title: 'Please clear the Teams cache',
      body: 'Hello, please clear the Teams cache on the laptop and try again.',
      action: {
        actionKey: 'act.clear-teams-cache',
        label: 'Ask the user to clear the Teams cache',
        customerEffort: 'medium',
        durationMinutes: 5,
      },
    },
    {
      id: 'x03',
      timestamp: '2026-05-04T08:50:00Z',
      participantId: 'p-user',
      type: 'customer_email',
      channel: 'email',
      title: 'Re: Please clear the Teams cache',
      inResponseTo: 'x02',
      body: 'I cleared the Teams cache on the laptop and it now works, Teams signed in again.',
    },
  ],
  resolution: {
    resolvedAt: '2026-05-04T09:10:00Z',
    summary: 'Clearing the Teams cache restored sign-in on the single affected laptop.',
    rootCause: 'A corrupted local Teams cache on one laptop.',
    rootCauseHypothesisKey: 'hyp.client-cache',
    validation: {
      validatedAt: '2026-05-04T09:05:00Z',
      method: 'The user signed in successfully after the cache was cleared.',
      outcome: 'confirmed',
      evidenceEventIds: ['x03'],
    },
  },
});
export const IRRELEVANT = prepareBundle(IRRELEVANT_BUNDLE, 'case_syn_9001');

export const toSeedCase = (p: Prepared, createdBy = 'user_ava_engineer'): MutationSourceCase => ({
  caseId: p.ctx.caseId,
  reference: p.bundle.case.reference,
  synthetic: p.bundle.synthetic,
  caseInfo: { workload: p.bundle.case.workload, product: p.bundle.case.product },
  events: p.normalized.events,
  resolution: p.normalized.resolution,
  analysis: p.analysis,
  pack: p.pack,
  config: CONFIG,
  ctx: { ...p.ctx, createdBy },
});

export const toReplayCase = (p: Prepared): SkillReplayCase => toSeedCase(p);

const ENGINEER: Permission[] = ['skill:read', 'skill:apply', 'skill:extract'];
const REVIEWER: Permission[] = ['skill:read', 'skill:review', 'skill:validate'];
const CURATOR: Permission[] = [
  'skill:read',
  'skill:extract',
  'skill:mutate',
  'skill:validate',
  'skill:review',
  'skill:approve',
  'skill:publish',
  'skill:retire',
  'skill:rollback',
];

export const AVA: SkillActor = { id: 'user_ava_engineer', permissions: ENGINEER };
export const RILEY: SkillActor = { id: 'user_riley_reviewer', permissions: REVIEWER };
export const MORGAN: SkillActor = { id: 'user_morgan_manager', permissions: ['skill:read'] };
export const CASEY: SkillActor = { id: 'user_casey_curator', permissions: CURATOR };
export const ALEX: SkillActor = { id: 'user_alex_admin', permissions: [...CURATOR, 'skill:apply'] };
export const SYSTEM_BOT: SkillActor = {
  id: 'system_extractor',
  permissions: CURATOR,
  kind: 'system',
};

/** Ava drafts, Riley validates and reviews, Casey approves the pilot, Alex publishes. */
export const CAST: GovernanceCast = {
  drafter: AVA,
  validator: RILEY,
  reviewer: RILEY,
  approver: CASEY,
  publisher: ALEX,
};

export const makeOp = (seed = 'test', now = NOW) => ({
  tenantId: 'tenant_test',
  now,
  nextId: createSkillIdGenerator(seed),
});

let cached: SeedSkills | null = null;
export function seeded(): SeedSkills {
  if (cached) return cached;
  const result = deriveSeedSkills({
    caseOne: toSeedCase(ONE),
    caseTwo: toSeedCase(TWO),
    proposer: CASEY,
    op: makeOp('seed'),
    rolloutCount: 60,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  cached = result.value;
  return cached;
}

export const draftAggregate = (): SkillAggregate => {
  const { draft } = seeded();
  return { skill: draft.skill, versions: [draft.version], validations: [], approvals: [] };
};

export const REGRESSION_CASES = [
  { replayCase: toReplayCase(ONE), expectation: 'non_breaking' as const },
  { replayCase: toReplayCase(TWO), expectation: 'non_breaking' as const },
  { replayCase: toReplayCase(IRRELEVANT), expectation: 'not_applicable' as const },
];

let publishedCache: SkillAggregate | null = null;
/** The seeded skill taken to `published` through the real gates (never by the seed itself). */
export function publishedAggregate(): SkillAggregate {
  if (publishedCache) return publishedCache;
  const result = advanceSkillGovernance({
    aggregate: draftAggregate(),
    cast: CAST,
    op: makeOp('governance'),
    simulationCases: [toReplayCase(ONE)],
    regressionCases: REGRESSION_CASES,
    target: 'published',
  });
  if (!result.ok) throw new Error(`governance failed: ${result.error.message}`);
  publishedCache = result.value;
  return publishedCache;
}

/** A validation record for gate tests (the real ones come from the simulation functions). */
export function validationOf(
  aggregate: SkillAggregate,
  kind: SkillValidation['kind'],
  outcome: SkillValidation['outcome'],
  executedAt = NOW,
): SkillValidation {
  return {
    tenantId: 'tenant_test',
    createdAt: executedAt,
    updatedAt: executedAt,
    createdBy: RILEY.id,
    version: 1,
    id: `val_${kind}_${outcome}_${executedAt}`,
    skillId: aggregate.skill.id,
    versionId: aggregate.skill.currentVersionId,
    kind,
    outcome,
    caseId: null,
    checks: [{ id: 'fixture', passed: outcome === 'passed', detail: 'Test fixture.' }],
    executedBy: RILEY.id,
    executedAt,
    synthetic: true,
  };
}

export const asOf = (p: Prepared, suffix: string): string => {
  const event = p.normalized.events.find((e) => e.id.endsWith(suffix));
  if (!event) throw new Error(`No event ending with ${suffix}`);
  return event.timestamp;
};

/** The first element of a list the test expects to be non-empty. */
export function first<T>(items: readonly T[]): T {
  const head = items[0];
  if (head === undefined) throw new Error('Expected a non-empty list');
  return head;
}

export const versionOf = (aggregate: SkillAggregate): SkillVersion => {
  const version = currentVersionOf(aggregate);
  if (!version) throw new Error('The aggregate has no current version');
  return version;
};

export const matchableOf = (aggregate: SkillAggregate): MatchableSkill => ({
  skill: aggregate.skill,
  version: versionOf(aggregate),
});

export const caseInfoOf = (p: Prepared): CaseInfo => ({
  workload: p.bundle.case.workload,
  product: p.bundle.case.product,
});

/** Matches the given skills (the published seed skill by default) against what is known at `at`. */
export function matchAt(
  p: Prepared,
  at: string,
  skills: readonly MatchableSkill[] = [matchableOf(publishedAggregate())],
  analysisAsOf: AnalysisAsOf = p.analysis,
): SkillMatchSet {
  return matchSkills({
    skills,
    analysisAsOf,
    asOf: at,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    caseInfo: caseInfoOf(p),
  });
}

/**
 * The same case with everything after `at` rewritten into misleading text (a single user, a server-side
 * error) and a different resolution. Anything that leaks the future into a decision at `at` shows up
 * as a difference against the untouched case.
 */
export function withPoisonedFuture(p: Prepared, at: string): AnalysisAsOf {
  const events = p.normalized.events.map((e) =>
    e.timestamp > at
      ? {
          ...e,
          title: 'Only one user on a single laptop',
          body: 'Only one user is affected on a single laptop. The error is name not resolved (DNS_PROBE_FINISHED_NXDOMAIN) and the server returned a 500 error.',
        }
      : e,
  );
  const resolution = p.normalized.resolution
    ? {
        ...p.normalized.resolution,
        rootCauseHypothesisKey: 'hyp.client-cache',
        summary: 'Cache cleared.',
      }
    : null;
  return { view: createFullView(events, resolution) };
}

/** The same case truncated right after `at`: no later events and no resolution at all. */
export function withoutFuture(p: Prepared, at: string): AnalysisAsOf {
  return {
    view: createFullView(
      p.normalized.events.filter((e) => e.timestamp <= at),
      null,
    ),
  };
}
