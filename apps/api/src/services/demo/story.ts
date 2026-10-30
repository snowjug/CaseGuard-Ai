import type { SkillDna, SkillMatch } from '@caseguard/schemas';
import { AppError, ConflictError } from '../../errors';
import { findStoryCase, findStorySkill } from './facts';
import { STORY_CASES, type StoryCase } from './story-cases';
import { walkLifecycle } from './story-lifecycle';
import {
  REASONS,
  begin,
  isValidatedMatch,
  skip,
  type StoryOutcome,
  type StoryRun,
} from './story-stages';

export { STORY_STAGES, type StoryOutcome, type StoryRun } from './story-stages';

async function importCase(run: StoryRun, stage: string, story: StoryCase): Promise<string> {
  const { engineer } = run.actors;
  const existing = await findStoryCase(engineer, story);
  if (existing !== null) {
    await skip(run, stage, `${story.reference} is already in the workspace`);
    return existing.id;
  }
  await begin(run, stage, `Importing ${story.reference} from the built-in samples`);
  const result = await engineer.services.ingestion.ingest(engineer, {
    source: { type: 'sample', sampleId: story.sampleId },
    analyze: false,
  });
  return result.case.id;
}

async function analyseCaseOne(run: StoryRun, caseId: string): Promise<void> {
  const { engineer } = run.actors;
  const record = await engineer.repos.cases.get(caseId);
  if (record?.analysisState === 'analyzed') {
    await skip(run, 'analyse-one', 'Case One has already been analysed');
    return;
  }
  await begin(run, 'analyse-one', 'Reconstructing the timeline, evidence, hypotheses and forks');
  await engineer.services.analysis.analyzeCase(engineer, caseId);
}

/** The scenario of the earliest meaningful fork a reviewer accepts (every strategy is stored for it). */
async function acceptBetterPath(run: StoryRun, caseId: string): Promise<string> {
  const { engineer, reviewer } = run.actors;
  const forks = await reviewer.repos.analysis.listForks(caseId);
  const earliest = forks.find((fork) => fork.isEarliestMeaningful);
  if (earliest === undefined) {
    throw new ConflictError('Case One has no earliest meaningful decision fork to review.');
  }
  const stored = await engineer.services.counterfactuals.ensureScenarios(engineer, caseId);
  const scenarios = stored.filter((scenario) => scenario.forkId === earliest.id);

  const accepted = scenarios.find((scenario) => scenario.reviewState === 'confirmed');
  if (accepted !== undefined) {
    await skip(run, 'accept-path', 'A path at the earliest fork was already accepted');
    return accepted.id;
  }
  const usable = scenarios.filter(
    (scenario) =>
      scenario.reviewState === 'pending' &&
      scenario.status === 'completed' &&
      scenario.validity.valid &&
      scenario.boundary.leakCheck.passed,
  );
  const chosen = usable.find((scenario) => scenario.strategy === 'balanced') ?? usable[0];
  if (chosen === undefined) {
    throw new ConflictError('No valid simulated path at the earliest fork is waiting for review.');
  }
  await begin(run, 'accept-path', 'Reviewing the balanced path for the earliest meaningful fork');
  await reviewer.services.counterfactuals.review(reviewer, caseId, chosen.id, {
    decision: 'accept',
    reason: REASONS.accept,
    expectedVersion: chosen.version,
  });
  return chosen.id;
}

async function extractSkill(run: StoryRun, caseId: string, scenarioId: string): Promise<SkillDna> {
  const { engineer } = run.actors;
  const existing = await findStorySkill(engineer, caseId);
  if (existing !== null) {
    await skip(run, 'extract-skill', 'A skill from Case One already exists');
    return existing;
  }
  await begin(run, 'extract-skill', 'Distilling the accepted path into a draft skill');
  const [skill] = await engineer.services.skills.extractForCase(engineer, caseId, { scenarioId });
  if (skill === undefined)
    throw new ConflictError('No skill could be extracted from the accepted path.');
  return skill;
}

const APPLICABILITY_TEXT: Readonly<Record<SkillMatch['applicability'], string>> = {
  applies: 'applies',
  partial: 'partly applies',
  not_applicable: 'does not apply',
};

async function analyseCaseTwo(run: StoryRun, caseId: string, skillId: string): Promise<void> {
  const { engineer } = run.actors;
  const stored = await engineer.repos.skills.listMatchesForCase(caseId);
  const matched = stored.some(
    (match) =>
      match.skillId === skillId &&
      isValidatedMatch(match) &&
      match.applicability !== 'not_applicable',
  );
  const record = await engineer.repos.cases.get(caseId);
  if (record?.analysisState === 'analyzed' && matched) {
    await skip(run, 'analyse-two', 'Case Two is analysed and the skill is already matched');
    return;
  }
  await begin(run, 'analyse-two', 'Analysing Case Two with the published skill in the library');
  await engineer.services.analysis.analyzeCase(engineer, caseId);
  const matches = await engineer.services.skills.matchForCase(engineer, caseId);
  if (!matches.some((match) => match.skillId === skillId)) {
    throw new ConflictError(
      'The published skill was not matched to Case Two: it covers another workload.',
    );
  }

  // Read-only: what the skill would have suggested from the first email alone (never stored).
  const first = await engineer.repos.cases.listEvents(caseId, { limit: 1 });
  const firstAt = first.items[0]?.timestamp;
  if (firstAt === undefined) return;
  const early = await engineer.services.skills.matchForCase(engineer, caseId, { asOf: firstAt });
  const atFirstEmail = early.find((match) => match.skillId === skillId);
  if (atFirstEmail !== undefined) {
    await run.handle.stage(
      'analyse-two',
      `As of the first email the skill ${APPLICABILITY_TEXT[atFirstEmail.applicability]} (score ${atFirstEmail.score.toFixed(2)}, estimated)`,
    );
  }
}

async function applyGuidedPlan(run: StoryRun, caseId: string, skillId: string): Promise<void> {
  const { engineer } = run.actors;
  const stored = await engineer.repos.skills.listMatchesForCase(caseId);
  if (stored.some((match) => match.skillId === skillId && match.applied)) {
    await skip(run, 'apply-skill', 'The guided plan was already applied');
    return;
  }
  await begin(run, 'apply-skill', 'Recording that the guided plan was followed and how closely');
  await engineer.services.skills.applyToCase(engineer, caseId, skillId);
}

/**
 * Case Two also teaches the skill: a refinement is PROPOSED (never applied: approving it needs a
 * different person and validations on the new content). This is not one of the 13 steps, so a refusal
 * by the engine is recorded in the stage detail and the log instead of failing the story.
 */
async function proposeRefinement(run: StoryRun, caseId: string, skillId: string): Promise<void> {
  const { curator } = run.actors;
  const versions = await curator.repos.skills.listVersions(skillId);
  if (versions.length > 1) {
    await skip(run, 'mutation', 'The skill already has a proposed or decided refinement');
    return;
  }
  await begin(run, 'mutation', 'Looking for what Case Two adds to the skill');
  try {
    const result = await curator.services.skills.proposeMutation(curator, skillId, caseId);
    const detail =
      result.status === 'proposed'
        ? `Proposed version ${result.version.version}; it stays a proposal until a different person approves it`
        : 'The engine found nothing in Case Two to add to the skill';
    await run.handle.stage('mutation', detail);
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    curator.logger.warn(
      { event: 'demo.seed.mutation_not_proposed', skillId, code: error.code, status: error.status },
      'the refinement of the story skill was not proposed',
    );
    await run.handle.stage(
      'mutation',
      `No refinement was proposed: ${error.message}`.slice(0, 280),
    );
  }
}

/**
 * Plays the story through the real services, each step as the persona it names. Every stage first
 * looks at what is already stored and skips it when done, so a repeat run changes nothing and an
 * interrupted run resumes where it stopped.
 */
export async function playStory(run: StoryRun): Promise<StoryOutcome> {
  const caseOneId = await importCase(run, 'import-one', STORY_CASES.one);
  await analyseCaseOne(run, caseOneId);
  const scenarioId = await acceptBetterPath(run, caseOneId);
  const skill = await extractSkill(run, caseOneId, scenarioId);
  await walkLifecycle(run, skill.id);
  const caseTwoId = await importCase(run, 'import-two', STORY_CASES.two);
  await analyseCaseTwo(run, caseTwoId, skill.id);
  await applyGuidedPlan(run, caseTwoId, skill.id);
  await proposeRefinement(run, caseTwoId, skill.id);
  return { caseOneId, caseTwoId, skillId: skill.id };
}
