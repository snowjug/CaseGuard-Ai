import type { ModelExecutionWithUsage, ProviderStatus } from '@caseguard/schemas';
import type { AnalysisSnapshot } from '../../db';
import type { RequestContext } from '../../http/request-context';
import type { AnalysisComputation } from './compute';
import type { AnalysisInputs } from './inputs';

export interface SnapshotInput {
  readonly ctx: RequestContext;
  readonly inputs: AnalysisInputs;
  readonly computation: AnalysisComputation;
  readonly executions: readonly ModelExecutionWithUsage[];
  readonly runId: string;
  readonly inputHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly provider: ProviderStatus;
  readonly engineVersion: string;
}

/** Assembles what one run stores: the run record plus every artefact, ready for one transaction. */
export function buildSnapshot(input: SnapshotInput): AnalysisSnapshot {
  const { ctx, inputs, computation, executions, runId, provider } = input;
  const { analysis } = computation;
  const meta = {
    tenantId: ctx.scope.tenantId,
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
    createdBy: 'system:analysis',
    version: 1,
  };

  return {
    run: {
      ...meta,
      id: runId,
      caseId: inputs.caseRecord.id,
      status: 'succeeded',
      provider: provider.kind,
      model: provider.model,
      simulated: provider.simulated,
      knowledgePackId: inputs.pack.pack.id,
      knowledgePackVersion: inputs.pack.pack.version,
      qualityConfigVersion: inputs.qualityConfig.version,
      actionValueConfigVersion: inputs.actionConfig.version,
      inputHash: input.inputHash,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      counts: {
        events: inputs.events.length,
        evidence: analysis.evidence.length,
        claims: analysis.claims.length,
        hypotheses: analysis.hypotheses.length,
        actions: analysis.actions.length,
        forks: analysis.forks.length,
        warnings: computation.warnings.length,
        modelExecutions: executions.length,
      },
      error: null,
    },
    twin: computation.twin,
    evidence: analysis.evidence,
    links: analysis.links,
    claims: analysis.claims,
    missing: analysis.missing,
    hypotheses: analysis.hypotheses,
    actions: analysis.actions,
    forks: analysis.forks,
    quality: computation.review,
    metrics: computation.metrics,
    warnings: computation.warnings,
    coaching: computation.coaching,
    skillMatches: computation.skillMatches.matches,
    executions: [...executions],
  };
}
