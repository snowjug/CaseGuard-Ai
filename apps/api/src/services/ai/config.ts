import type { AppConfig } from '@caseguard/config';
import type { AgentBudget, ModelConfig } from '@caseguard/schemas';

const minNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

/**
 * The model settings a tenant's administrators chose, tightened by what the operator allows in this
 * environment: a tenant may spend less than the operator's caps but never more, and cannot switch to a
 * provider that is not connected. Unit prices fall back to the operator's when the tenant set none, so
 * cost stays "unknown" (null) rather than invented when nobody configured prices.
 */
export function effectiveModelConfig(tenant: ModelConfig, config: AppConfig): ModelConfig {
  const { limits } = config.ai;
  const capBudget = (budget: AgentBudget): AgentBudget => ({
    maxInputTokens: Math.min(budget.maxInputTokens, limits.maxInputTokens),
    maxOutputTokens: Math.min(budget.maxOutputTokens, limits.maxOutputTokens),
    maxRetries: Math.min(budget.maxRetries, limits.maxRetries),
    timeoutMs: Math.min(budget.timeoutMs, limits.timeoutMs),
  });
  const azure = config.ai.provider === 'azure-openai' ? config.ai : null;

  return {
    ...tenant,
    provider: config.ai.provider,
    azureDeployment: azure?.deployment ?? tenant.azureDeployment,
    azureApiVersion: azure?.apiVersion ?? tenant.azureApiVersion,
    maxInputTokens: Math.min(tenant.maxInputTokens, limits.maxInputTokens),
    maxOutputTokens: Math.min(tenant.maxOutputTokens, limits.maxOutputTokens),
    timeoutMs: Math.min(tenant.timeoutMs, limits.timeoutMs),
    maxRetries: Math.min(tenant.maxRetries, limits.maxRetries),
    agentBudgets: Object.fromEntries(
      Object.entries(tenant.agentBudgets).map(([agent, budget]) => [agent, capBudget(budget)]),
    ),
    costLimits: {
      ...tenant.costLimits,
      perDayUsd: minNullable(tenant.costLimits.perDayUsd, limits.costLimitUsdPerDay),
    },
    unitPrices: {
      ...tenant.unitPrices,
      inputPer1kUsd: tenant.unitPrices.inputPer1kUsd ?? limits.unitPriceInputPer1k,
      outputPer1kUsd: tenant.unitPrices.outputPer1kUsd ?? limits.unitPriceOutputPer1k,
    },
  };
}
