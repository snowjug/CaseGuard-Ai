import type { AppEnvironment, AuthMode, FeatureFlags, Role } from '@caseguard/schemas';
import type { Secret } from './secret';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface RuntimeConfig {
  readonly env: AppEnvironment;
  readonly serviceName: string;
  readonly version: string;
  readonly gitCommit: string | null;
  /** Local or test: relaxed defaults and development tooling are allowed. */
  readonly localLike: boolean;
  /** Staging or production: strict guards apply. */
  readonly deployed: boolean;
  readonly production: boolean;
}

/**
 * Which proxies may tell the API the client's address (`X-Forwarded-For`). `false` ignores the header;
 * `true` believes every hop, so a client can pick its own address (local use only); a number trusts
 * that many proxies counted from the API; a list trusts proxies at those addresses or ranges.
 */
export type TrustProxySetting = boolean | number | readonly string[];

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly corsAllowedOrigins: readonly string[];
  readonly trustProxy: TrustProxySetting;
  readonly bodyLimitBytes: number;
  readonly uploadMaxBytes: number;
}

export interface EntraConfig {
  readonly tenantId: string;
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUri: string;
  /** Entra tenant id -> CaseGuard tenant id. A token from an unmapped tenant is rejected. */
  readonly tenantMap: Readonly<Record<string, string>>;
  /** Entra app role value -> CaseGuard role. */
  readonly roleMap: Readonly<Record<string, Role>>;
}

export interface AuthConfig {
  readonly mode: AuthMode;
  /** Second explicit switch for the persona login. Never true in production. */
  readonly devAuthEnabled: boolean;
  readonly entra: EntraConfig | null;
  /** User-assigned managed identity client id used by DefaultAzureCredential, when set. */
  readonly azureClientId: string | null;
}

export interface DatabaseConfig {
  readonly kind: 'pglite' | 'postgres';
  /** The full connection URL. Reveal it only where the driver is created. */
  readonly url: Secret;
  /** A description that is safe to log: no password, no secret query values. */
  readonly display: string;
  readonly auth: 'password' | 'entra';
  readonly autoMigrate: boolean;
  readonly poolMax: number;
}

export type StorageConfig =
  | { readonly provider: 'local'; readonly localDir: string }
  | { readonly provider: 'azure-blob'; readonly account: string; readonly container: string };

export type SearchConfig =
  | { readonly provider: 'lexical' }
  | { readonly provider: 'azure-ai-search'; readonly endpoint: string; readonly index: string };

export interface CacheConfig {
  readonly provider: 'memory';
}

export interface AiLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Null means no cap. When set, both unit prices are guaranteed to be set as well. */
  readonly costLimitUsdPerDay: number | null;
  /** Operator-supplied price per 1,000 tokens. Null means cost is reported as unknown. */
  readonly unitPriceInputPer1k: number | null;
  readonly unitPriceOutputPer1k: number | null;
}

export type AiProviderConfig =
  | { readonly provider: 'deterministic' }
  | {
      readonly provider: 'azure-openai';
      readonly endpoint: string;
      readonly deployment: string;
      readonly apiVersion: string;
      readonly auth: 'managed-identity' | 'api-key';
      readonly apiKey: Secret | null;
    };

export type AiConfig = AiProviderConfig & { readonly limits: AiLimits };

export interface LimitsConfig {
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitAiMax: number;
  readonly malwareScanMode: 'none' | 'eicar-test';
}

export interface TelemetryConfig {
  readonly appInsightsConnectionString: Secret | null;
  readonly otelServiceName: string;
  readonly otelSamplingRatio: number;
}

export interface DemoConfig {
  readonly mode: boolean;
  readonly autoSeed: boolean;
}

export interface AppConfig {
  readonly runtime: RuntimeConfig;
  readonly logLevel: LogLevel;
  readonly http: HttpConfig;
  readonly auth: AuthConfig;
  readonly database: DatabaseConfig;
  readonly storage: StorageConfig;
  readonly search: SearchConfig;
  readonly cache: CacheConfig;
  readonly ai: AiConfig;
  readonly limits: LimitsConfig;
  readonly telemetry: TelemetryConfig;
  readonly demo: DemoConfig;
  readonly features: FeatureFlags;
  /** Non-fatal oddities worth printing once at start-up. */
  readonly warnings: readonly string[];
}
