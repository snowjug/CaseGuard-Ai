import pino from 'pino';
import type { AppEnvironment } from '@caseguard/schemas';
import { systemClock, toIsoTimestamp, type Clock } from '../clock';
import { getContextLogFields } from '../context/store';
import { createScrubber, type Scrubber } from '../redaction/scrubber';
import { REDACTED } from '../redaction/rules';
import { createPrettyDestination, type LogDestination } from './pretty';
import { PINO_REDACT_PATHS } from './redact-paths';
import { createRequestSerializer, createResponseSerializer } from './serializers';

/** Accepted log levels, in increasing severity, plus `silent`. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
/** A log level accepted by `createLogger`. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The pino logger the API's Fastify instance can use directly (`loggerInstance`). */
export type Logger = pino.Logger;

/** Environments in which the human-readable formatter may replace JSON output. */
const PRETTY_ENVIRONMENTS: ReadonlySet<AppEnvironment> = new Set(['local', 'development', 'test']);

/** Options for `createLogger`. */
export interface LoggerOptions {
  readonly service: string;
  readonly version: string;
  readonly env: AppEnvironment;
  readonly level?: LogLevel;
  /** Build commit, added to every line when provided. */
  readonly commit?: string;
  /** Where JSON lines go. Defaults to synchronous stdout. */
  readonly destination?: LogDestination;
  /**
   * Extra text redactor, for example the security package's. It runs after the built-in rules on
   * every message, string field and error; if it throws, the text is replaced by a placeholder.
   */
  readonly redact?: (text: string) => string;
  /** Human-readable output. Ignored (JSON is kept) in staging and production. */
  readonly pretty?: boolean;
  /** Colourise pretty output. Default false. */
  readonly color?: boolean;
  /** Clock for the `time` field. Inject a fixed clock in tests. */
  readonly clock?: Clock;
  /** Additional field names to always redact. */
  readonly extraSensitiveKeys?: readonly string[];
  /** Called with the rule id whenever redaction rewrote text (never with the matched value). */
  readonly onRedaction?: (ruleId: string) => void;
  /** Called when the injected redactor or a hostile object forced a placeholder. */
  readonly onRedactionError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveLevel(level: LogLevel | undefined): LogLevel {
  const resolved = level ?? 'info';
  if (!LOG_LEVELS.includes(resolved)) {
    throw new RangeError(
      `Unknown log level "${String(resolved)}"; expected one of ${LOG_LEVELS.join(', ')}`,
    );
  }
  return resolved;
}

function stdoutDestination(): LogDestination {
  return {
    write(chunk: string): void {
      process.stdout.write(chunk);
    },
  };
}

function baseBindings(options: LoggerOptions, scrubber: Scrubber): Record<string, string> {
  return {
    service: scrubber.text(options.service, 120),
    version: scrubber.text(options.version, 120),
    env: options.env,
    ...(options.commit ? { commit: scrubber.text(options.commit, 80) } : {}),
  };
}

type ChildOptions = pino.ChildLoggerOptions | undefined;

/**
 * Children may change level and message prefix, and add serialisers for new keys. They may not
 * replace the formatters, redact paths or the `msg`/`err` serialisers that carry the scrubbing.
 */
function sanitizeChildOptions(options: ChildOptions): ChildOptions {
  if (options === undefined) return undefined;
  const clean: pino.ChildLoggerOptions = {};
  if (options.level !== undefined) clean.level = resolveLevel(options.level as LogLevel);
  if (options.msgPrefix !== undefined) clean.msgPrefix = options.msgPrefix;
  if (options.serializers !== undefined) {
    const serializers: NonNullable<pino.ChildLoggerOptions['serializers']> = {};
    for (const [key, serializer] of Object.entries(options.serializers)) {
      if (key !== 'msg' && key !== 'err' && key !== 'error') serializers[key] = serializer;
    }
    clean.serializers = serializers;
  }
  return clean;
}

/**
 * Creates the structured logger: JSON lines with ISO timestamps, base fields (service, version, env,
 * commit), correlation fields (requestId, traceId, spanId, tenantId, userId) merged from the async
 * context, and redaction at four layers:
 *
 * 1. the mixin merge strategy deep-scrubs every logged object (credential/PII-named keys at any depth,
 *    token shapes, connection strings, SAS signatures and emails inside strings, error stacks and
 *    causes) and neutralises hostile objects such as throwing getters;
 * 2. the `msg` serialiser scrubs the message after `%s` interpolation;
 * 3. `child()` scrubs binding values; and
 * 4. pino `redact` paths cover the usual header and credential fields as a second net.
 *
 * It never writes through `console`, and stack traces are omitted when `env` is `production`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = resolveLevel(options.level);
  const scrubber = createScrubber({
    includeStack: options.env !== 'production',
    ...(options.redact ? { redact: options.redact } : {}),
    ...(options.extraSensitiveKeys ? { extraSensitiveKeys: options.extraSensitiveKeys } : {}),
    ...(options.onRedaction ? { onRedaction: options.onRedaction } : {}),
    ...(options.onRedactionError ? { onError: options.onRedactionError } : {}),
  });
  const clock = options.clock ?? systemClock;

  let destination: LogDestination = options.destination ?? stdoutDestination();
  if (options.pretty === true && PRETTY_ENVIRONMENTS.has(options.env)) {
    destination = createPrettyDestination(destination, { color: options.color === true });
  }

  const scrubValue = (value: unknown): unknown => scrubber.value(value);
  const scrubMessage = (value: unknown): unknown =>
    typeof value === 'string' ? scrubber.text(value) : scrubber.value(value);

  const logger = pino(
    {
      level,
      base: baseBindings(options, scrubber),
      timestamp: () => `,"time":"${toIsoTimestamp(clock())}"`,
      messageKey: 'msg',
      errorKey: 'err',
      redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTED },
      serializers: {
        err: scrubValue,
        error: scrubValue,
        msg: scrubMessage,
        req: createRequestSerializer(scrubber),
        res: createResponseSerializer(),
      },
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      mixin: () => getContextLogFields(),
      // pino merges the logged object with the mixin here, before anything reads it, so this is also
      // where hostile objects (throwing getters) must be neutralised and where scrubbing happens.
      mixinMergeStrategy: (mergeObject: object, mixinObject: object): object => {
        const scrubbed = scrubber.value(mergeObject);
        return { ...mixinObject, ...(isRecord(scrubbed) ? scrubbed : {}) };
      },
    },
    destination,
  );

  const originalChild: unknown = Reflect.get(logger, 'child');
  if (typeof originalChild !== 'function') {
    throw new TypeError('pino logger has no child() method');
  }
  const scrubbedChild = function child(
    this: Logger,
    bindings: pino.Bindings,
    childOptions?: pino.ChildLoggerOptions,
  ): Logger {
    const cleanBindings = scrubber.value(bindings);
    const args: unknown[] = [isRecord(cleanBindings) ? cleanBindings : {}];
    const cleanOptions = sanitizeChildOptions(childOptions);
    if (cleanOptions !== undefined) args.push(cleanOptions);
    return Reflect.apply(originalChild, this, args) as Logger;
  };
  Object.defineProperty(logger, 'child', {
    value: scrubbedChild,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return logger;
}
