import {
  getCompiledPack,
  listKnowledgePacks,
  type CompiledPack,
  type EngineContext,
  type MatchableSkill,
} from '@caseguard/domain';
import type {
  ActionValueConfig,
  AnalysisRun,
  Case,
  CaseEvent,
  CaseResolution,
  CaseSource,
  QualityConfig,
} from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';

/**
 * Bump when the meaning of any analysis output changes (engine, scoring, warning rules). It is part
 * of the input hash, so a new engine re-analyses cases instead of silently reusing stale results.
 */
export const ENGINE_VERSION = '2026.1.0';

/** Everything an analysis reads. Loaded once per run and never mutated. */
export interface AnalysisInputs {
  readonly caseRecord: Case;
  readonly source: CaseSource;
  readonly events: readonly CaseEvent[];
  readonly resolution: CaseResolution | null;
  readonly pack: CompiledPack;
  readonly actionConfig: ActionValueConfig;
  readonly qualityConfig: QualityConfig;
  /** Skills that may match this case (pilot, validated or published for the workload). */
  readonly skills: readonly MatchableSkill[];
  readonly unitPrices: {
    readonly inputPer1kUsd: number | null;
    readonly outputPer1kUsd: number | null;
    readonly cachedInputPer1kUsd: number | null;
  };
}

/** Loads a case with everything its analysis depends on. 404 across tenants, 422 for an unknown workload. */
export async function loadAnalysisInputs(
  ctx: RequestContext,
  caseId: string,
): Promise<AnalysisInputs> {
  const caseRecord = await ctx.repos.cases.get(caseId);
  if (caseRecord === null) throw new NotFoundError('Case', caseId);

  const pack = getCompiledPack(caseRecord.workload);
  if (pack === null) {
    const supported = listKnowledgePacks()
      .map((knowledge) => knowledge.workload)
      .join(', ');
    throw new ValidationFailedError(
      `No knowledge pack is available for the "${caseRecord.workload}" workload (supported: ${supported})`,
      [{ path: 'case.workload', message: 'Unsupported workload' }],
    );
  }

  const [source, events, resolution, settings, skills] = await Promise.all([
    ctx.repos.cases.getSource(caseId),
    ctx.repos.cases.getAllEvents(caseId),
    ctx.repos.cases.getResolution(caseId),
    ctx.repos.governance.getSettings(),
    ctx.repos.skills.listMatchable(caseRecord.workload),
  ]);
  if (source === null) throw new NotFoundError('Case source', caseId);

  return {
    caseRecord,
    source,
    events,
    resolution,
    pack,
    actionConfig: settings.action_value.value,
    qualityConfig: settings.quality.value,
    skills,
    unitPrices: {
      inputPer1kUsd: settings.model.value.unitPrices.inputPer1kUsd,
      outputPer1kUsd: settings.model.value.unitPrices.outputPer1kUsd,
      cachedInputPer1kUsd: settings.model.value.unitPrices.cachedInputPer1kUsd,
    },
  };
}

export interface ProviderIdentity {
  readonly kind: string;
  readonly model: string;
}

export interface EngineContextInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly inputHash: string;
}

/**
 * The identity the engine runs under. Artefact ids, timestamps and the simulation seed derive from it,
 * so a view that recomputes an analysis from the stored record (for an as-of request) must build its
 * context with `engineContextForRun` to get exactly the ids that were stored.
 */
export function engineContextFor(input: EngineContextInput): EngineContext {
  return {
    tenantId: input.tenantId,
    caseId: input.caseId,
    runId: input.runId,
    now: input.startedAt,
    createdBy: 'system:analysis',
    seed: input.inputHash,
  };
}

export function engineContextForRun(run: AnalysisRun): EngineContext {
  return engineContextFor({
    tenantId: run.tenantId,
    caseId: run.caseId,
    runId: run.id,
    startedAt: run.startedAt,
    inputHash: run.inputHash,
  });
}

/**
 * Identifies the exact input of an analysis. Identical input never re-runs. The hash covers what can
 * change the result (the stored payload, the pack, both governed configurations, the skill library the
 * matcher sees, the engine version and the provider) and nothing that cannot, such as reviewer
 * corrections (they are carried forward across runs).
 */
export function computeInputHash(inputs: AnalysisInputs, provider: ProviderIdentity): string {
  return sha256Hex(
    canonicalJson({
      engine: ENGINE_VERSION,
      source: inputs.source.receivedSha256,
      events: inputs.events.length,
      resolution: inputs.resolution !== null,
      pack: [inputs.pack.pack.id, inputs.pack.pack.version],
      actionConfig: sha256Hex(canonicalJson(inputs.actionConfig)),
      qualityConfig: sha256Hex(canonicalJson(inputs.qualityConfig)),
      skills: inputs.skills
        .map((entry) => [entry.skill.id, entry.version.id, entry.skill.lifecycle])
        .sort(),
      provider: [provider.kind, provider.model],
    }),
  );
}
