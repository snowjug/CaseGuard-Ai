import { createKeyClassifier, isSecretHeaderName, type KeyClass } from './keys';
import { applyTextRules, REDACTED } from './rules';
import { sanitizeUrlWith } from './url';

/** Appended to text that was cut to a length limit. */
export const TRUNCATION_MARKER = '…[truncated]';
const UNREADABLE = '[Unreadable]';
const UNSERIALIZABLE = '[Unserializable]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const REDACTOR_FAILED = '[REDACTED:redactor-failed]';

/** Longest string handed to the pattern rules; bounds CPU spent on a single hostile value. */
const MAX_SCAN_CHARS = 32_768;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_CODE_LENGTH = 64;
const MAX_KEY_OUTPUT_LENGTH = 200;
const MAX_CACHED_KEY_LENGTH = 120;
const MAX_KEY_CACHE_ENTRIES = 2048;
const ERROR_CORE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'message',
  'stack',
  'cause',
  'code',
  'status',
  'statusCode',
  'errors',
]);
const ERROR_TYPE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.]{0,79}$/;

/** Error shape written to logs. `stack` is absent when stacks are disabled (production). */
export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  status?: number;
  cause?: unknown;
  errors?: unknown[];
  props?: Record<string, unknown>;
}

/** Options for `createScrubber`. */
export interface ScrubberOptions {
  /** Extra text redactor (for example the security package's). Runs after the built-in rules and fails closed. */
  readonly redact?: (text: string) => string;
  /** Mask emails, SSN-like numbers, payment cards and user names in file paths. Default true. */
  readonly pii?: boolean;
  /** Include (scrubbed) stack traces in serialised errors. Default true; disable in production. */
  readonly includeStack?: boolean;
  /** Additional field names whose values are always redacted (matched after normalising case and punctuation). */
  readonly extraSensitiveKeys?: readonly string[];
  readonly maxStringLength?: number;
  readonly maxStackLength?: number;
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxKeys?: number;
  readonly maxNodes?: number;
  /**
   * Characters of string content scrubbed per `value()` call. Beyond it strings become `[Truncated]`, so
   * a huge logged object cannot cost unbounded regex time. Default 262 144.
   */
  readonly maxTotalChars?: number;
  /** Called with the rule id whenever a pattern rule rewrote text (never with the matched value). */
  readonly onRedaction?: (ruleId: string) => void;
  /** Called when the injected redactor or a hostile object made the scrubber degrade to a placeholder. */
  readonly onError?: (error: unknown) => void;
}

/** Text, value and error scrubbing with one consistent configuration. */
export interface Scrubber {
  /** Scrubs free text: credentials, token shapes, connection strings, SAS signatures, PII; bounded length. */
  text(input: string, maxLength?: number): string;
  /** Deep-clones any value into JSON-safe data with sensitive fields and strings scrubbed. Never throws. */
  value(input: unknown): unknown;
  /** Serialises an error (or any thrown value) with a scrubbed message, optional stack and cause chain. */
  error(input: unknown): SerializedError;
  classifyKey(key: string): KeyClass;
}

interface WalkState {
  nodes: number;
  /** String characters scrubbed so far, against `maxTotalChars`. */
  chars: number;
  /** Objects on the current path only, so shared (non-cyclic) references are still serialised. */
  readonly path: Set<object>;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = text.slice(0, Math.max(0, maxLength - TRUNCATION_MARKER.length));
  const last = cut.charCodeAt(cut.length - 1);
  // A dangling high surrogate would serialise as an invalid character.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}${TRUNCATION_MARKER}`;
}

const TOKEN_DELIMITERS = new Set([
  '"',
  "'",
  '<',
  '>',
  ',',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '\\',
]);

function isTokenCharacter(char: string): boolean {
  return char.trim() !== '' && !TOKEN_DELIMITERS.has(char);
}

/** Drops the trailing run of token characters so a cut can never leave half a secret behind. */
function trimToTokenBoundary(text: string): string {
  let end = text.length;
  while (end > 0 && isTokenCharacter(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

class ScrubberImpl implements Scrubber {
  private readonly classify: (key: string) => KeyClass;
  private readonly pii: boolean;
  private readonly includeStack: boolean;
  private readonly maxStringLength: number;
  private readonly maxStackLength: number;
  private readonly maxDepth: number;
  private readonly maxArrayLength: number;
  private readonly maxKeys: number;
  private readonly maxNodes: number;
  private readonly maxTotalChars: number;
  /** Property names repeat on every log line, so their scrubbed form is memoised (bounded). */
  private readonly keyCache = new Map<string, string>();

  constructor(private readonly options: ScrubberOptions) {
    this.classify = createKeyClassifier(options.extraSensitiveKeys);
    this.pii = options.pii ?? true;
    this.includeStack = options.includeStack ?? true;
    this.maxStringLength = options.maxStringLength ?? 4096;
    this.maxStackLength = options.maxStackLength ?? 8192;
    this.maxDepth = options.maxDepth ?? 8;
    this.maxArrayLength = options.maxArrayLength ?? 100;
    this.maxKeys = options.maxKeys ?? 100;
    this.maxNodes = options.maxNodes ?? 2000;
    this.maxTotalChars = options.maxTotalChars ?? 262_144;
  }

  classifyKey(key: string): KeyClass {
    return this.classify(key);
  }

  text(input: string, maxLength: number = this.maxStringLength): string {
    let working = input;
    let clipped = false;
    if (working.length > MAX_SCAN_CHARS) {
      working = trimToTokenBoundary(working.slice(0, MAX_SCAN_CHARS));
      clipped = true;
    }
    let result = applyTextRules(working, { pii: this.pii, onHit: this.options.onRedaction });
    result = this.applyInjectedRedactor(result);
    if (clipped) result = `${result}${TRUNCATION_MARKER}`;
    return truncate(result, maxLength);
  }

  value(input: unknown): unknown {
    try {
      return this.walk(input, 0, { nodes: 0, chars: 0, path: new Set() });
    } catch (error) {
      this.options.onError?.(error);
      return UNSERIALIZABLE;
    }
  }

  error(input: unknown): SerializedError {
    try {
      if (input instanceof Error) {
        return this.serializeError(input, 0, { nodes: 1, chars: 0, path: new Set([input]) });
      }
      return { type: 'NonError', message: this.describeNonError(input) };
    } catch (error) {
      this.options.onError?.(error);
      return { type: 'Error', message: UNSERIALIZABLE };
    }
  }

  private applyInjectedRedactor(text: string): string {
    const redactor = this.options.redact;
    if (redactor === undefined) return text;
    try {
      const redacted = redactor(text);
      return typeof redacted === 'string' ? redacted : REDACTOR_FAILED;
    } catch (error) {
      // Fail closed: if the extra redactor breaks we cannot vouch for the text, so none of it is kept.
      this.options.onError?.(error);
      return REDACTOR_FAILED;
    }
  }

  private describeNonError(input: unknown): string {
    if (typeof input === 'string') return this.text(input, MAX_MESSAGE_LENGTH);
    const json = JSON.stringify(this.value(input));
    return this.text(json ?? 'undefined', MAX_MESSAGE_LENGTH);
  }

  private read(source: object, key: PropertyKey): unknown {
    try {
      return Reflect.get(source, key);
    } catch (error) {
      this.options.onError?.(error);
      return UNREADABLE;
    }
  }

  private ownKeys(source: object): string[] {
    try {
      return Object.keys(source);
    } catch (error) {
      this.options.onError?.(error);
      return [];
    }
  }

  private walk(value: unknown, depth: number, state: WalkState): unknown {
    switch (typeof value) {
      case 'string':
        state.chars += value.length;
        return state.chars > this.maxTotalChars ? TRUNCATED : this.text(value);
      case 'number':
        return Number.isFinite(value) ? value : String(value);
      case 'boolean':
        return value;
      case 'bigint':
        return value.toString();
      case 'symbol':
        return this.text(value.toString());
      case 'undefined':
      case 'function':
        return undefined;
      default:
        break;
    }
    if (value === null) return null;
    return typeof value === 'object' ? this.walkObject(value, depth, state) : undefined;
  }

  private walkObject(value: object, depth: number, state: WalkState): unknown {
    if (depth >= this.maxDepth) return TRUNCATED;
    if (state.path.has(value)) return CIRCULAR;
    state.nodes += 1;
    if (state.nodes > this.maxNodes) return TRUNCATED;
    state.path.add(value);
    try {
      return this.walkObjectBody(value, depth, state);
    } finally {
      state.path.delete(value);
    }
  }

  private walkObjectBody(value: object, depth: number, state: WalkState): unknown {
    if (value instanceof Error) return this.serializeError(value, depth, state);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return `[Binary ${value.byteLength} bytes]`;
    }
    if (value instanceof URL) return sanitizeUrlWith(value.href, (text) => this.text(text));
    if (value instanceof RegExp) return this.text(value.toString());
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
      return `[${value.constructor.name}]`;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean) {
      return this.walk(value.valueOf(), depth + 1, state);
    }
    if (value instanceof Map) return this.walkMap(value, depth, state);
    if (value instanceof Set) return this.walkSet(value, depth, state);
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      return this.walkEntries(Array.from(value.entries()), depth, state);
    }
    if (Array.isArray(value)) {
      const items: unknown[] =
        value.length > this.maxArrayLength ? value.slice(0, this.maxArrayLength) : value;
      return this.walkArray(items, value.length, depth, state);
    }
    const toJson = this.read(value, 'toJSON');
    if (typeof toJson === 'function') {
      try {
        const json: unknown = Reflect.apply(toJson, value, []);
        return this.walk(json, depth + 1, state);
      } catch (error) {
        this.options.onError?.(error);
        return UNSERIALIZABLE;
      }
    }
    const keys = this.ownKeys(value);
    const entries: [string, unknown][] = [];
    for (const key of keys.length > this.maxKeys ? keys.slice(0, this.maxKeys) : keys) {
      entries.push([key, this.read(value, key)]);
    }
    return this.walkEntries(entries, depth, state, keys.length);
  }

  private walkMap(map: Map<unknown, unknown>, depth: number, state: WalkState): unknown {
    const entries: [string, unknown][] = [];
    for (const [key, item] of map) {
      if (entries.length >= this.maxKeys) break;
      entries.push([
        typeof key === 'string' ? key : this.text(String(key), MAX_KEY_OUTPUT_LENGTH),
        item,
      ]);
    }
    return this.walkEntries(entries, depth, state, map.size);
  }

  private walkSet(set: Set<unknown>, depth: number, state: WalkState): unknown {
    const items: unknown[] = [];
    for (const item of set) {
      if (items.length >= this.maxArrayLength) break;
      items.push(item);
    }
    return this.walkArray(items, set.size, depth, state);
  }

  private walkArray(
    items: readonly unknown[],
    total: number,
    depth: number,
    state: WalkState,
  ): unknown[] {
    const out: unknown[] = [];
    let redactNext = false;
    for (const item of items) {
      if (redactNext) {
        out.push(REDACTED);
        redactNext = false;
        continue;
      }
      // Flat header lists (`['Authorization', 'Bearer ...']`) carry the credential in the next slot.
      if (typeof item === 'string' && item.length <= 64 && isSecretHeaderName(item)) {
        redactNext = true;
      }
      const walked = this.walk(item, depth + 1, state);
      out.push(walked === undefined ? null : walked);
    }
    if (total > items.length) out.push(`[${total - items.length} more items]`);
    return out;
  }

  private scrubKey(key: string): string {
    const cached = this.keyCache.get(key);
    if (cached !== undefined) return cached;
    const scrubbed = this.text(key, MAX_KEY_OUTPUT_LENGTH);
    if (key.length <= MAX_CACHED_KEY_LENGTH) {
      if (this.keyCache.size >= MAX_KEY_CACHE_ENTRIES) this.keyCache.clear();
      this.keyCache.set(key, scrubbed);
    }
    return scrubbed;
  }

  private walkEntries(
    entries: readonly (readonly [string, unknown])[],
    depth: number,
    state: WalkState,
    totalKeys: number = entries.length,
  ): Record<string, unknown> {
    // A plain object (not null-prototype): pino calls `bindings.hasOwnProperty` on what we hand back.
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const safeKey = this.scrubKey(key);
      const walked = this.walkMember(this.classify(key), item, depth, state);
      // Functions and undefined have no JSON form; leaving the key out matches what serialisation does anyway.
      if (walked === undefined) continue;
      if (safeKey === '__proto__') {
        // Plain assignment would call the prototype setter instead of creating the property.
        Object.defineProperty(out, safeKey, {
          value: walked,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[safeKey] = walked;
      }
    }
    if (totalKeys > entries.length) out['…'] = `[${totalKeys - entries.length} more keys]`;
    return out;
  }

  /** Booleans and nullish values cannot carry a secret, so they stay visible (`passwordRequired: true`). */
  private walkMember(keyClass: KeyClass, item: unknown, depth: number, state: WalkState): unknown {
    if (keyClass === 'secret') {
      const inert =
        item === null ||
        item === undefined ||
        typeof item === 'boolean' ||
        typeof item === 'function';
      return inert ? this.walk(item, depth + 1, state) : REDACTED;
    }
    if (keyClass === 'pii' && (typeof item === 'string' || isObject(item))) return REDACTED;
    return this.walk(item, depth + 1, state);
  }

  private errorType(error: Error): string {
    const name = this.read(error, 'name');
    if (typeof name === 'string' && ERROR_TYPE_PATTERN.test(name)) return name;
    const constructorValue = this.read(error, 'constructor');
    const constructorName = isObject(constructorValue)
      ? this.read(constructorValue, 'name')
      : undefined;
    return typeof constructorName === 'string' && ERROR_TYPE_PATTERN.test(constructorName)
      ? constructorName
      : 'Error';
  }

  private serializeError(error: Error, depth: number, state: WalkState): SerializedError {
    const message = this.read(error, 'message');
    const out: SerializedError = {
      type: this.errorType(error),
      message: this.text(typeof message === 'string' ? message : '', MAX_MESSAGE_LENGTH),
    };
    if (this.includeStack) {
      const stack = this.read(error, 'stack');
      if (typeof stack === 'string') out.stack = this.text(stack, this.maxStackLength);
    }
    const code = this.read(error, 'code');
    if (typeof code === 'string') out.code = this.text(code, MAX_CODE_LENGTH);
    else if (typeof code === 'number' && Number.isFinite(code)) out.code = code;
    const status = this.read(error, 'status') ?? this.read(error, 'statusCode');
    if (typeof status === 'number' && Number.isFinite(status)) out.status = status;
    const cause = this.read(error, 'cause');
    if (cause !== undefined) out.cause = this.walk(cause, depth + 1, state);
    const nested = this.read(error, 'errors');
    if (Array.isArray(nested)) {
      const items: unknown[] =
        nested.length > this.maxArrayLength ? nested.slice(0, this.maxArrayLength) : nested;
      out.errors = this.walkArray(items, nested.length, depth, state);
    }
    const extras: [string, unknown][] = [];
    for (const key of this.ownKeys(error)) {
      if (ERROR_CORE_KEYS.has(key)) continue;
      if (extras.length >= this.maxKeys) break;
      extras.push([key, this.read(error, key)]);
    }
    if (extras.length > 0) out.props = this.walkEntries(extras, depth, state);
    return out;
  }
}

/** Creates a scrubber. Instances share nothing; the key classifier memo is private to each one. */
export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  return new ScrubberImpl(options);
}
