import {
  AiOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AiHealth,
  type InjectionScanner,
  type Logger as AiLogger,
  type ModelProvider,
  type Redactor,
} from '@caseguard/ai';
import type { AgentName, ModelExecutionWithUsage, ProviderStatus } from '@caseguard/schemas';
import { detectPromptInjection, redactText } from '@caseguard/security';
import type { RequestContext } from '../../http/request-context';
import type { BaseInfrastructure } from '../../infrastructure';
import type { AiPort, AiRunOptions } from '../ports';
import { effectiveModelConfig } from './config';
import { createConfiguredProvider, type ProviderFactory } from './provider';

export { effectiveModelConfig } from './config';
export type { ProviderFactory } from './provider';

/** Prefixes handed out by the AI package may contain characters our id generator does not accept. */
const idPrefix = (prefix: string): string => {
  const clean = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 16);
  return clean.length >= 2 ? clean : 'ai';
};

const redactor: Redactor = (text) => redactText(text).text;

const injectionScanner: InjectionScanner = (text) =>
  detectPromptInjection(text).map(({ ruleId, severity, excerpt }) => ({
    ruleId,
    severity,
    excerpt,
  }));

interface TenantOrchestrator {
  /** Version of the tenant's `model` governance setting this orchestrator was built from. */
  readonly settingsVersion: number;
  readonly orchestrator: AiOrchestrator;
  /** True when the configured provider could not be created and deterministic code serves instead. */
  readonly unavailable: boolean;
  readonly builtAtMs: number;
}

/** After the configured provider could not be created, the next attempt waits this long. */
export const PROVIDER_RETRY_AFTER_MS = 60_000;

const PROVIDER_UNAVAILABLE =
  'The configured Azure OpenAI provider could not be created, so analyses use the deterministic knowledge-pack provider (simulated values) until it can. See the server log.';

/** Honest health while the configured provider is missing: deterministic code is serving, and it says so. */
function withProviderUnavailable(health: AiHealth): AiHealth {
  return {
    ...health,
    status: 'degraded',
    degraded: true,
    degradedReason: PROVIDER_UNAVAILABLE,
    provider: { ...health.provider, healthy: false, detail: PROVIDER_UNAVAILABLE },
    dependency: { ...health.dependency, status: 'degraded', detail: PROVIDER_UNAVAILABLE },
    notes: [PROVIDER_UNAVAILABLE, ...health.notes],
  };
}

function startOfUtcDay(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

export interface AiServiceOptions {
  /** Test seam: replaces how the configured provider is built. */
  readonly providerFactory?: ProviderFactory;
}

/**
 * One orchestrator per tenant, rebuilt whenever that tenant's `model` setting changes, so budgets,
 * routing and cache limits follow governance. The provider is created once per process. Every run
 * persists its execution record (hashes and metadata only, never prompts or raw model output) and
 * feeds the product metrics, so the efficiency monitor reports what actually ran.
 *
 * A provider that cannot be created (a configuration fault, a missing credential chain) must not take
 * the product down: the deterministic analysis is the product. The failure is logged and counted, the
 * health says so, deterministic code serves, and creation is tried again after a minute rather than
 * remembered for the life of the process.
 */
export class AiService implements AiPort {
  private provider: Promise<ModelProvider | undefined> | null = null;
  private providerFailedAtMs: number | null = null;
  private readonly tenants = new Map<string, Promise<TenantOrchestrator>>();

  constructor(
    private readonly infra: BaseInfrastructure,
    private readonly options: AiServiceOptions = {},
  ) {}

  async run<A extends AgentName>(
    ctx: RequestContext,
    request: AgentRunRequest<A>,
    options: AiRunOptions = {},
  ): Promise<AgentRunResult<A>> {
    const { orchestrator } = await this.orchestratorFor(ctx);
    const result = await orchestrator.runAgentTask({
      ...request,
      signal: request.signal ?? ctx.signal,
      correlationId: request.correlationId ?? ctx.requestId,
    });
    this.recordMetrics(ctx, result);
    if (options.persist !== false)
      await ctx.repos.telemetry.saveExecutions([result.modelExecution]);
    return result;
  }

  async status(ctx: RequestContext): Promise<ProviderStatus> {
    return (await this.health(ctx)).provider;
  }

  async health(ctx: RequestContext): Promise<AiHealth> {
    const entry = await this.orchestratorFor(ctx);
    const health = entry.orchestrator.getHealth();
    return entry.unavailable ? withProviderUnavailable(health) : health;
  }

  // ------------------------------------------------------------ internals

  /**
   * The configured provider, or `undefined` for deterministic code. `unavailable` is true when a
   * provider was configured but could not be created.
   */
  private async providerOnce(): Promise<{
    provider: ModelProvider | undefined;
    unavailable: boolean;
  }> {
    const nowMs = this.infra.now().getTime();
    if (
      this.providerFailedAtMs !== null &&
      nowMs - this.providerFailedAtMs < PROVIDER_RETRY_AFTER_MS
    ) {
      return { provider: undefined, unavailable: true };
    }
    const attempt = (this.provider ??= (this.options.providerFactory ?? createConfiguredProvider)(
      this.infra.config,
      this.aiLogger(),
    ));
    try {
      const provider = await attempt;
      this.providerFailedAtMs = null;
      return { provider, unavailable: false };
    } catch (error) {
      if (this.provider === attempt) this.provider = null;
      this.providerFailedAtMs = nowMs;
      this.infra.logger.error(
        { err: error },
        'could not create the configured AI provider; deterministic code serves until it can',
      );
      this.infra.metrics.recordError('ai', 'provider_unavailable');
      return { provider: undefined, unavailable: true };
    }
  }

  private aiLogger(): AiLogger {
    const { logger } = this.infra;
    return {
      debug: (fields, message) => logger.debug(fields, message),
      info: (fields, message) => logger.info(fields, message),
      warn: (fields, message) => logger.warn(fields, message),
      error: (fields, message) => logger.error(fields, message),
    };
  }

  private async orchestratorFor(ctx: RequestContext): Promise<TenantOrchestrator> {
    const settings = await ctx.repos.governance.getSettings();
    const { version } = settings.model;
    const key = ctx.scope.tenantId;

    const existing = this.tenants.get(key);
    if (existing !== undefined) {
      const entry = await existing;
      // An orchestrator that serves without the configured provider is rebuilt once the retry delay has
      // passed, so a provider that recovers is picked up without a restart.
      const retryDue =
        entry.unavailable &&
        this.infra.now().getTime() - entry.builtAtMs >= PROVIDER_RETRY_AFTER_MS;
      if (entry.settingsVersion === version && !retryDue) return entry;
    }
    const built = this.build(ctx, settings.model.value, version);
    this.tenants.set(key, built);
    try {
      return await built;
    } catch (error) {
      // Do not cache a failed construction (for example an unreachable credential chain).
      if (this.tenants.get(key) === built) this.tenants.delete(key);
      throw error;
    }
  }

  private async build(
    ctx: RequestContext,
    tenantConfig: Parameters<typeof effectiveModelConfig>[0],
    settingsVersion: number,
  ): Promise<TenantOrchestrator> {
    const { provider, unavailable } = await this.providerOnce();
    const { infra } = this;
    const orchestrator = new AiOrchestrator({
      config: effectiveModelConfig(tenantConfig, infra.config),
      ...(provider ? { provider } : {}),
      clock: { nowMs: () => infra.now().getTime() },
      ids: { next: (prefix) => infra.newId(idPrefix(prefix)) },
      logger: this.aiLogger(),
      redactor,
      injectionScanner,
    });

    // Daily budgets survive restarts: seed the in-memory ledger from what was already recorded today.
    const today = await ctx.repos.telemetry.aggregate({ since: startOfUtcDay(infra.now()) });
    const { promptTokens, completionTokens, estimatedCostUsd } = today.totals;
    orchestrator.governor.restoreDailyUsage(
      ctx.scope.tenantId,
      promptTokens + completionTokens,
      estimatedCostUsd,
    );
    return { settingsVersion, orchestrator, unavailable, builtAtMs: infra.now().getTime() };
  }

  private recordMetrics<A extends AgentName>(ctx: RequestContext, result: AgentRunResult<A>): void {
    const execution: ModelExecutionWithUsage = result.modelExecution;
    const usage = execution.usage;
    ctx.metrics.recordModelCall({
      agent: execution.agent,
      provider: execution.provider,
      status: execution.status,
      latencyMs: execution.latencyMs,
      tokenSource: usage?.tokenSource ?? 'estimated',
      ...(usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            cacheHit: usage.cacheHit,
          }
        : {}),
      ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
      ...(result.rejection ? { validationFailures: validationKinds(result.rejection.kinds) } : {}),
    });
    if (result.inputFlags.injectionIndicators > 0) ctx.metrics.recordInjectionFlag('case_text');
  }
}

type FailureKind = 'schema' | 'citation' | 'policy' | 'temporal';

/** The AI package has seven validator kinds; metrics keep a bounded set of four. */
function validationKinds(kinds: readonly string[]): FailureKind[] {
  const mapped = new Set<FailureKind>();
  for (const kind of kinds) {
    if (kind === 'temporal') mapped.add('temporal');
    else if (kind === 'citation' || kind === 'groundedness') mapped.add('citation');
    else if (kind === 'policy' || kind === 'injection') mapped.add('policy');
    else mapped.add('schema');
  }
  return [...mapped];
}

export function createAiService(infra: BaseInfrastructure, options: AiServiceOptions = {}): AiPort {
  return new AiService(infra, options);
}
