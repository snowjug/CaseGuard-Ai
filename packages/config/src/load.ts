import { DEFAULT_FEATURE_FLAGS } from '@caseguard/schemas';
import type { BuildContext } from './context';
import { ConfigError, type ConfigIssue } from './errors';
import { blankToUndefined } from './primitives';
import { RawEnvSchema } from './raw-env';
import { buildAi } from './sections/ai';
import { buildAuth } from './sections/auth';
import { buildDatabase } from './sections/database';
import { buildHttp } from './sections/http';
import { buildDemo, buildLimitsConfig, buildTelemetry } from './sections/misc';
import { buildSearch, buildStorage } from './sections/storage';
import type { AppConfig, LogLevel } from './types';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** Used when APP_VERSION is unset; the entry point passes its package version. */
  readonly defaultVersion?: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const DEFAULT_VERSION = '0.0.0-dev';

function freezeSections<T extends object>(value: T): T {
  for (const section of Object.values(value)) {
    if (typeof section === 'object' && section !== null && !Object.isFrozen(section)) {
      Object.freeze(section);
    }
  }
  return Object.freeze(value);
}

/**
 * An unset APP_ENV means `local`, which enables persona login and the other development defaults.
 * That is right on a laptop and wrong in a production runtime, where a forgotten variable must not
 * silently select it. NODE_ENV=production (the API image sets it) therefore requires APP_ENV to be
 * named explicitly; any valid value is accepted. Matching ignores case and surrounding whitespace so
 * a variant such as `Production` cannot slip past the guard.
 */
function unsetAppEnvInProduction(env: EnvSource): ConfigIssue | null {
  const nodeEnv = blankToUndefined(env.NODE_ENV);
  const production = typeof nodeEnv === 'string' && nodeEnv.toLowerCase() === 'production';
  if (!production || blankToUndefined(env.APP_ENV) !== undefined) return null;
  return {
    variable: 'APP_ENV',
    message:
      'must be set explicitly when NODE_ENV=production: an unset value would mean local, which enables persona login and other development defaults',
  };
}

/** Parses and validates the environment without throwing. */
export function validateConfig(
  env: EnvSource = process.env,
  options: LoadConfigOptions = {},
): ConfigResult {
  // APP_ENV decides which rules apply to every other variable, so an unset one in production is
  // reported on its own (together with any variable too malformed to parse) instead of validating
  // the rest under a guess.
  const unsetAppEnv = unsetAppEnvInProduction(env);
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const malformed = parsed.error.issues.map((issue) => ({
      variable: String(issue.path[0] ?? '(environment)'),
      message: issue.message,
    }));
    return { ok: false, issues: unsetAppEnv === null ? malformed : [unsetAppEnv, ...malformed] };
  }
  if (unsetAppEnv !== null) return { ok: false, issues: [unsetAppEnv] };

  const raw = parsed.data;
  const appEnv = raw.APP_ENV ?? 'local';
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const ctx: BuildContext = {
    raw,
    env: appEnv,
    localLike: appEnv === 'local' || appEnv === 'test',
    deployed: appEnv === 'staging' || appEnv === 'production',
    production: appEnv === 'production',
    fail: (variable, message) => {
      issues.push({ variable, message });
    },
    warn: (message) => {
      warnings.push(message);
    },
  };

  const serviceName = raw.SERVICE_NAME ?? 'caseguard-api';
  const logLevel: LogLevel = raw.LOG_LEVEL ?? 'info';
  if (ctx.production && (logLevel === 'debug' || logLevel === 'trace')) {
    warnings.push(`LOG_LEVEL=${logLevel} in production can expose more detail than intended.`);
  }

  const auth = buildAuth(ctx);
  const database = buildDatabase(ctx);
  const ai = buildAi(ctx);
  const demo = buildDemo(ctx);
  const config: AppConfig = {
    runtime: {
      env: appEnv,
      serviceName,
      version: raw.APP_VERSION ?? options.defaultVersion ?? DEFAULT_VERSION,
      gitCommit: raw.GIT_COMMIT ?? null,
      localLike: ctx.localLike,
      deployed: ctx.deployed,
      production: ctx.production,
    },
    logLevel,
    http: buildHttp(ctx),
    auth,
    database,
    storage: buildStorage(ctx),
    search: buildSearch(ctx),
    cache: { provider: raw.CACHE_PROVIDER ?? 'memory' },
    ai,
    limits: buildLimitsConfig(ctx),
    telemetry: buildTelemetry(ctx, serviceName),
    demo,
    features: {
      ...DEFAULT_FEATURE_FLAGS,
      presentationMode: demo.mode,
      azureOpenAiProvider: ai.provider === 'azure-openai',
    },
    warnings: Object.freeze([...warnings]),
  };

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: freezeSections(config) };
}

/**
 * Loads the configuration or throws a ConfigError listing every problem (never a value). Call once
 * at start-up and refuse to boot on failure.
 */
export function loadConfig(
  env: EnvSource = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const result = validateConfig(env, options);
  if (!result.ok) throw new ConfigError(result.issues);
  return result.config;
}
