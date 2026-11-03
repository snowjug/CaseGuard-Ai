import type { EfficiencyOverview } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { effectiveModelConfig } from '../ai';
import { getGovernanceValue } from '../governance/accessor';
import { readAiHealth } from '../system';
import { caseProcessOf, tokenProcessOf, type TokenProcess } from './case-process';
import { buildEfficiencyOverview, type CaseProcessScope } from './overview';

export {
  agentInputLimit,
  buildEfficiencyOverview,
  type CaseProcessScope,
  type EfficiencyInputs,
} from './overview';
export { caseProcessOf, tokenProcessOf, type TokenProcess } from './case-process';

/** Without a case the comparison adds up this many of the most recently analysed cases. */
const PORTFOLIO_CASES = 25;

async function tokenProcessFor(ctx: RequestContext, caseId: string): Promise<TokenProcess | null> {
  return tokenProcessOf(await ctx.repos.analysis.listMetrics(caseId));
}

async function loadCaseProcess(
  ctx: RequestContext,
  caseId: string | null,
): Promise<{ caseProcess: EfficiencyOverview['caseProcess']; scope: CaseProcessScope }> {
  if (caseId !== null) {
    const process = await tokenProcessFor(ctx, caseId);
    return {
      caseProcess: caseProcessOf(caseId, process === null ? [] : [process]),
      scope: { kind: 'case' },
    };
  }
  const page = await ctx.repos.cases.list({ limit: PORTFOLIO_CASES, analysisState: 'analyzed' });
  const found = await Promise.all(page.items.map((item) => tokenProcessFor(ctx, item.id)));
  const parts = found.filter((part): part is TokenProcess => part !== null);
  return {
    caseProcess: caseProcessOf(null, parts),
    scope: { kind: 'portfolio', analysedCases: parts.length },
  };
}

/**
 * `efficiency.overview`: model usage recorded by the AI service (tenant-wide, or for one case), the
 * governed budgets, the provider's circuit breakers and the real-versus-simulated token comparison.
 * A case that is not found (or belongs to another tenant) is treated as no case: the figures then
 * cover every case and a note says so, so a page that remembered a deleted case still renders.
 */
export async function getEfficiencyOverview(
  ctx: RequestContext,
  query: { readonly caseId?: string | undefined },
): Promise<EfficiencyOverview> {
  const requested = query.caseId === undefined ? null : await ctx.repos.cases.get(query.caseId);
  const caseId = requested?.id ?? null;
  const [telemetry, tenantModel, ai, process] = await Promise.all([
    ctx.repos.telemetry.aggregate(caseId === null ? {} : { caseId }),
    getGovernanceValue(ctx, 'model'),
    readAiHealth(ctx),
    loadCaseProcess(ctx, caseId),
  ]);
  return buildEfficiencyOverview({
    now: ctx.now().toISOString(),
    telemetry,
    model: effectiveModelConfig(tenantModel, ctx.config),
    simulated: ai?.provider.simulated ?? ctx.config.ai.provider !== 'azure-openai',
    breakers:
      ai === null
        ? null
        : ai.breakers.map((breaker) => ({
            name: breaker.name,
            state: breaker.state,
            consecutiveFailures: breaker.consecutiveFailures,
            openedAt: breaker.openedAt,
          })),
    caseProcess: process.caseProcess,
    scope: process.scope,
    requestedCaseMissing: query.caseId !== undefined && requested === null,
  });
}
