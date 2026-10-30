import { envBoolean, envEnum, envInt, envNumber, envString, envTrustProxy } from './primitives';
import { z } from 'zod';

export const APP_ENVS = ['local', 'test', 'development', 'staging', 'production'] as const;
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Every environment variable the application reads, each validated on its own. Cross-variable
 * rules (production guards, "this requires that") live in `load.ts`. Unknown variables are ignored.
 */
export const RawEnvSchema = z.object({
  APP_ENV: envEnum(APP_ENVS),
  SERVICE_NAME: envString(80),
  APP_VERSION: envString(64),
  GIT_COMMIT: envString(64),

  API_HOST: envString(255),
  API_PORT: envInt(1, 65_535),
  CORS_ALLOWED_ORIGINS: envString(2_000),
  TRUST_PROXY: envTrustProxy(),
  TRUST_CLIENT_IP_HEADER: envBoolean(),
  LOG_LEVEL: envEnum(LOG_LEVELS),

  AUTH_MODE: envEnum(['dev', 'entra'] as const),
  DEV_AUTH_ENABLED: envBoolean(),
  ENTRA_TENANT_ID: envString(100),
  ENTRA_AUDIENCE: envString(300),
  ENTRA_ISSUER: envString(300),
  ENTRA_JWKS_URI: envString(500),
  ENTRA_TENANT_MAP: envString(4_000),
  ENTRA_ROLE_MAP: envString(4_000),
  AZURE_CLIENT_ID: envString(64),

  DATABASE_URL: envString(2_048),
  DATABASE_AUTH: envEnum(['password', 'entra'] as const),
  DB_AUTO_MIGRATE: envBoolean(),
  DB_POOL_MAX: envInt(1, 200),

  STORAGE_PROVIDER: envEnum(['local', 'azure-blob'] as const),
  STORAGE_LOCAL_DIR: envString(500),
  AZURE_STORAGE_ACCOUNT: envString(63),
  AZURE_STORAGE_CONTAINER: envString(63),

  SEARCH_PROVIDER: envEnum(['lexical', 'azure-ai-search'] as const),
  AZURE_SEARCH_ENDPOINT: envString(500),
  AZURE_SEARCH_INDEX: envString(128),
  CACHE_PROVIDER: envEnum(['memory'] as const),

  AI_PROVIDER: envEnum(['deterministic', 'azure-openai'] as const),
  AZURE_OPENAI_ENDPOINT: envString(500),
  AZURE_OPENAI_DEPLOYMENT: envString(128),
  AZURE_OPENAI_API_VERSION: envString(40),
  AZURE_OPENAI_AUTH: envEnum(['managed-identity', 'api-key'] as const),
  AZURE_OPENAI_API_KEY: envString(512),
  AI_MAX_INPUT_TOKENS: envInt(1_000, 1_000_000),
  AI_MAX_OUTPUT_TOKENS: envInt(100, 200_000),
  AI_TIMEOUT_MS: envInt(1_000, 600_000),
  AI_MAX_RETRIES: envInt(0, 10),
  AI_COST_LIMIT_USD_PER_DAY: envNumber(0, 1_000_000),
  AI_UNIT_PRICE_INPUT_PER_1K: envNumber(0, 10_000),
  AI_UNIT_PRICE_OUTPUT_PER_1K: envNumber(0, 10_000),

  RATE_LIMIT_MAX: envInt(1, 1_000_000),
  RATE_LIMIT_WINDOW_MS: envInt(1_000, 3_600_000),
  RATE_LIMIT_AI_MAX: envInt(1, 1_000_000),
  BODY_LIMIT_BYTES: envInt(1_024, 104_857_600),
  UPLOAD_MAX_BYTES: envInt(1_024, 104_857_600),
  MALWARE_SCAN_MODE: envEnum(['none', 'eicar-test'] as const),

  APPLICATIONINSIGHTS_CONNECTION_STRING: envString(2_048),
  OTEL_SERVICE_NAME: envString(80),
  OTEL_SAMPLING_RATIO: envNumber(0, 1),

  DEMO_MODE: envBoolean(),
  DEMO_AUTO_SEED: envBoolean(),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;
