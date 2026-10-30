import { diffSkillVersions } from '@caseguard/domain';
import type {
  Page,
  SimulateSkillBody,
  SkillDetail,
  SkillDiff,
  SkillDna,
  SkillMatch,
  SkillRollbackBody,
  SkillTransitionBody,
  SkillValidation,
  SkillVersion,
  SkillVersionDecisionBody,
  Job,
} from '@caseguard/schemas';
import type { SkillListQuery } from '../../db';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { ServiceDeps } from '..';
import { ReplayLoader } from '../counterfactuals/replay';
import type {
  ColdPassOptions,
  MatchOptions,
  SkillExtractionOptions,
  SkillMutationResult,
  SkillsPort,
} from '../ports';
import { SkillApplier } from './application';
import { loadSkillDetail } from './detail';
import { SkillExtractor } from './extraction';
import { decideVersionStep, rollbackStep, transitionSkillStep } from './governance';
import { CaseMatcher } from './matching';
import { SkillMutator } from './mutation';
import { SkillValidator } from './validation';

/**
 * The SkillDNA library: extraction from accepted counterfactuals, the governed lifecycle (four-eyes
 * and validation gates), versions, mutation proposals and rollback, simulation and regression tests,
 * as-of matching with guided plans, and applications with conformance and effectiveness. The README
 * next to this file names who walks a skill through its gates (the engineer extracts, the curator
 * drafts and approves the pilot, the reviewer validates, the administrator publishes) and why.
 */
export class SkillsService implements SkillsPort {
  private readonly replays = new ReplayLoader();
  private readonly matcher = new CaseMatcher();
  private readonly extractor = new SkillExtractor(this.replays);
  private readonly mutator = new SkillMutator(this.replays);
  private readonly validator = new SkillValidator(this.replays);
  private readonly applier = new SkillApplier(this.replays, this.matcher);

  // ------------------------------------------------------------ matching and application

  matchForCase(
    ctx: RequestContext,
    caseId: string,
    options: MatchOptions = {},
  ): Promise<SkillMatch[]> {
    return this.matcher.compute(ctx, caseId, options);
  }

  applyMatch(
    ctx: RequestContext,
    caseId: string,
    matchId: string,
    options: ColdPassOptions = {},
  ): Promise<SkillMatch> {
    return this.applier.applyMatch(ctx, caseId, matchId, options);
  }

  applyToCase(
    ctx: RequestContext,
    caseId: string,
    skillId: string,
    options: ColdPassOptions = {},
  ): Promise<SkillMatch> {
    return this.applier.apply(ctx, caseId, skillId, options);
  }

  // ------------------------------------------------------------ library

  list(ctx: RequestContext, query: SkillListQuery): Promise<Page<SkillDna>> {
    return ctx.repos.skills.list(query);
  }

  get(ctx: RequestContext, skillId: string): Promise<SkillDetail> {
    return loadSkillDetail(ctx, skillId);
  }

  async versions(ctx: RequestContext, skillId: string): Promise<SkillVersion[]> {
    await this.requireSkill(ctx, skillId);
    return ctx.repos.skills.listVersions(skillId);
  }

  async diff(
    ctx: RequestContext,
    skillId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<SkillDiff> {
    await this.requireSkill(ctx, skillId);
    const from = await ctx.repos.skills.getVersion(skillId, fromVersionId);
    if (from === null) throw new NotFoundError('Skill version', fromVersionId);
    const to = await ctx.repos.skills.getVersion(skillId, toVersionId);
    if (to === null) throw new NotFoundError('Skill version', toVersionId);
    return diffSkillVersions({ skillId, from, to });
  }

  // ------------------------------------------------------------ extraction

  extractForCase(
    ctx: RequestContext,
    caseId: string,
    options: SkillExtractionOptions = {},
  ): Promise<SkillDna[]> {
    return this.extractor.extract(ctx, caseId, options);
  }

  startExtraction(ctx: RequestContext, caseId: string, scenarioId: string): Promise<Job> {
    return this.extractor.start(ctx, caseId, scenarioId);
  }

  // ------------------------------------------------------------ governance

  async transition(
    ctx: RequestContext,
    skillId: string,
    input: SkillTransitionBody,
  ): Promise<SkillDetail> {
    await transitionSkillStep(ctx, skillId, input);
    return loadSkillDetail(ctx, skillId);
  }

  runValidation(
    ctx: RequestContext,
    skillId: string,
    input: Partial<SimulateSkillBody> = {},
  ): Promise<SkillValidation> {
    return this.validator.run(ctx, skillId, input);
  }

  proposeMutation(
    ctx: RequestContext,
    skillId: string,
    sourceCaseId: string,
  ): Promise<SkillMutationResult> {
    return this.mutator.propose(ctx, skillId, sourceCaseId);
  }

  startMutation(ctx: RequestContext, skillId: string, sourceCaseId: string): Promise<Job> {
    return this.mutator.start(ctx, skillId, sourceCaseId);
  }

  async decideVersion(
    ctx: RequestContext,
    skillId: string,
    versionId: string,
    input: SkillVersionDecisionBody,
  ): Promise<SkillDetail> {
    await decideVersionStep(ctx, skillId, versionId, input);
    return loadSkillDetail(ctx, skillId);
  }

  async rollback(
    ctx: RequestContext,
    skillId: string,
    input: SkillRollbackBody,
  ): Promise<SkillDetail> {
    await rollbackStep(ctx, skillId, input);
    return loadSkillDetail(ctx, skillId);
  }

  private async requireSkill(ctx: RequestContext, skillId: string): Promise<void> {
    if ((await ctx.repos.skills.get(skillId)) === null) throw new NotFoundError('Skill', skillId);
  }
}

export function createSkillsService(_deps: ServiceDeps): SkillsPort {
  return new SkillsService();
}
