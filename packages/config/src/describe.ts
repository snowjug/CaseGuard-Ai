import type { AppConfig, TrustProxySetting } from './types';

function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'off';
  if (setting === true) return 'every hop';
  if (typeof setting === 'number') return `${setting} ${setting === 1 ? 'hop' : 'hops'}`;
  return `${setting.length} address ${setting.length === 1 ? 'range' : 'ranges'}`;
}

/** Scheme, host and port only: userinfo, path, query and fragment can never reach a log line. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}

export interface ConfigSummary {
  readonly environment: string;
  readonly service: string;
  readonly version: string;
  readonly commit: string | null;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly corsOrigins: readonly string[];
    readonly trustProxy: string;
    readonly trustClientIpHeader: boolean;
  };
  readonly auth: {
    readonly mode: string;
    readonly personaLogin: boolean;
    readonly entraTenantMappings: number;
  };
  readonly database: {
    readonly kind: string;
    readonly target: string;
    readonly auth: string;
    readonly autoMigrate: boolean;
    readonly poolMax: number;
  };
  readonly storage: Record<string, string>;
  readonly search: Record<string, string>;
  readonly ai: {
    readonly provider: string;
    /** Origin of the Azure OpenAI endpoint (never a path, query or credentials); null otherwise. */
    readonly endpoint: string | null;
    readonly deployment: string | null;
    readonly auth: string | null;
    readonly credentialConfigured: boolean;
    readonly costCapConfigured: boolean;
  };
  readonly limits: {
    readonly rateLimitMax: number;
    readonly rateLimitAiMax: number;
    readonly malwareScanMode: string;
  };
  readonly telemetry: { readonly applicationInsights: boolean; readonly samplingRatio: number };
  readonly demo: { readonly mode: boolean; readonly autoSeed: boolean };
  readonly warnings: readonly string[];
}

/**
 * A summary that is safe to log at start-up or return from a diagnostics endpoint: it names what is
 * configured and never contains a secret, a password or a credential.
 */
export function describeConfig(config: AppConfig): ConfigSummary {
  const storage: Record<string, string> =
    config.storage.provider === 'local'
      ? { provider: 'local', directory: config.storage.localDir }
      : {
          provider: 'azure-blob',
          account: config.storage.account,
          container: config.storage.container,
        };
  const search: Record<string, string> =
    config.search.provider === 'lexical'
      ? { provider: 'lexical' }
      : {
          provider: 'azure-ai-search',
          endpoint: config.search.endpoint,
          index: config.search.index,
        };

  return {
    environment: config.runtime.env,
    service: config.runtime.serviceName,
    version: config.runtime.version,
    commit: config.runtime.gitCommit,
    http: {
      host: config.http.host,
      port: config.http.port,
      corsOrigins: config.http.corsAllowedOrigins,
      trustProxy: describeTrustProxy(config.http.trustProxy),
      trustClientIpHeader: config.http.trustClientIpHeader,
    },
    auth: {
      mode: config.auth.mode,
      personaLogin: config.auth.devAuthEnabled,
      entraTenantMappings: Object.keys(config.auth.entra?.tenantMap ?? {}).length,
    },
    database: {
      kind: config.database.kind,
      target: config.database.display,
      auth: config.database.auth,
      autoMigrate: config.database.autoMigrate,
      poolMax: config.database.poolMax,
    },
    storage,
    search,
    ai: {
      provider: config.ai.provider,
      endpoint: config.ai.provider === 'azure-openai' ? originOf(config.ai.endpoint) : null,
      deployment: config.ai.provider === 'azure-openai' ? config.ai.deployment : null,
      auth: config.ai.provider === 'azure-openai' ? config.ai.auth : null,
      credentialConfigured: config.ai.provider === 'azure-openai' && config.ai.apiKey !== null,
      costCapConfigured: config.ai.limits.costLimitUsdPerDay !== null,
    },
    limits: {
      rateLimitMax: config.limits.rateLimitMax,
      rateLimitAiMax: config.limits.rateLimitAiMax,
      malwareScanMode: config.limits.malwareScanMode,
    },
    telemetry: {
      applicationInsights: config.telemetry.appInsightsConnectionString !== null,
      samplingRatio: config.telemetry.otelSamplingRatio,
    },
    demo: { mode: config.demo.mode, autoSeed: config.demo.autoSeed },
    warnings: config.warnings,
  };
}
