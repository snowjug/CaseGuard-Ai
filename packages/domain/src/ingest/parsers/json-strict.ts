import { displayValue } from './text';

export interface StrictJsonLimits {
  maxDepth: number;
  maxNodes: number;
}

export type StrictJsonCode =
  | 'json_syntax'
  | 'json_too_deep'
  | 'json_too_complex'
  | 'json_duplicate_key'
  | 'json_forbidden_key'
  | 'json_invalid_string'
  | 'json_invalid_number';

export interface StrictJsonError {
  code: StrictJsonCode;
  message: string;
  hint: string;
  /** Where in the document: `events[3].body`, or `(root)`. */
  path: string;
  line: number;
  column: number;
  received: string | null;
}

export type StrictJsonResult =
  { ok: true; value: unknown; nodes: number } | { ok: false; error: StrictJsonError };

/** Keys that can poison `Object.prototype` when copied onto plain objects. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** The offending token for an error excerpt: up to the next separator, at most 24 characters. */
const TOKEN = /^[^\s,\]}]{1,24}/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

interface ArrayFrame {
  kind: 'array';
  value: unknown[];
}
interface ObjectFrame {
  kind: 'object';
  value: Record<string, unknown>;
  seen: Set<string>;
  key: string;
}
type Frame = ArrayFrame | ObjectFrame;

class Problem extends Error {
  constructor(
    readonly code: StrictJsonCode,
    message: string,
    readonly hint: string,
    readonly at: number,
    readonly received: string | null,
  ) {
    super(message);
  }
}

/** Path of the value being parsed. Keys come from the document, so each is bounded. */
export function formatJsonPath(stack: readonly Frame[]): string {
  let out = '';
  for (const frame of stack) {
    if (out.length > 120) return `${out.slice(0, 120)}…`;
    if (frame.kind === 'array') out += `[${frame.value.length}]`;
    else if (frame.key !== '') {
      out +=
        frame.key.length <= 40 && /^[A-Za-z_$][\w$]*$/.test(frame.key)
          ? `${out ? '.' : ''}${frame.key}`
          : `[${JSON.stringify(displayValue(frame.key, 30))}]`;
    }
  }
  return out === '' ? '(root)' : out;
}

/**
 * Strict RFC 8259 parser with an explicit stack (no recursion, so nesting depth cannot overflow
 * the call stack). It rejects what `JSON.parse` silently accepts or only fails on late:
 * duplicate keys, prototype-pollution keys, NUL or unpaired surrogates in strings, numbers
 * that overflow, nesting beyond `maxDepth` and more than `maxNodes` values.
 */
export function parseStrictJson(text: string, limits: StrictJsonLimits): StrictJsonResult {
  let i = 0;
  const n = text.length;
  const stack: Frame[] = [];
  let nodes = 0;
  let root: unknown;
  let done = false;

  const fail = (
    code: StrictJsonCode,
    message: string,
    hint: string,
    at = i,
    received?: string,
  ): never => {
    const token = received ?? TOKEN.exec(text.slice(at, at + 24))?.[0] ?? null;
    throw new Problem(code, message, hint, at, token);
  };
  const skipWhitespace = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i += 1;
      else break;
    }
  };
  const describe = (): string =>
    i >= n ? 'the end of the input' : `"${displayValue(text.charAt(i), 4)}"`;

  const readString = (): string => {
    const start = i;
    i += 1;
    let out = '';
    let segment = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(segment, i);
        i += 1;
        if (out.includes('\u0000') || LONE_SURROGATE.test(out)) {
          fail(
            'json_invalid_string',
            'A string contains a NUL character or an unpaired surrogate, which cannot be stored.',
            'Remove the character or re-export the file as UTF-8.',
            start,
          );
        }
        return out;
      }
      if (c === 0x5c) {
        out += text.slice(segment, i);
        i += 1;
        const escape = text.charAt(i);
        if (escape === 'u') {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            fail(
              'json_syntax',
              'A \\u escape needs four hexadecimal digits.',
              'Write \\u followed by exactly four hex digits.',
            );
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
        } else {
          const mapped = ESCAPES[escape];
          if (mapped === undefined) {
            fail(
              'json_syntax',
              `"\\${displayValue(escape, 2)}" is not a valid escape sequence.`,
              'Escape a backslash as \\\\ and a quote as \\".',
            );
          } else {
            out += mapped;
            i += 1;
          }
        }
        segment = i;
        continue;
      }
      if (c < 0x20) {
        fail(
          'json_invalid_string',
          'A string contains a raw control character (such as a line break).',
          'Write line breaks inside strings as \\n.',
        );
      }
      i += 1;
    }
    return fail(
      'json_syntax',
      'A string is never closed.',
      'Add the missing closing double quote.',
      start,
    );
  };

  const readKey = (frame: ObjectFrame): void => {
    // Problems found while reading a key belong to the object itself, not to the previous key.
    frame.key = '';
    skipWhitespace();
    if (text.charAt(i) !== '"') {
      fail(
        'json_syntax',
        `Expected a quoted key but found ${describe()}.`,
        text.charAt(i) === '}'
          ? 'Remove the trailing comma before the closing brace.'
          : 'Keys must be wrapped in double quotes.',
      );
    }
    const at = i;
    const key = readString();
    if (FORBIDDEN_KEYS.has(key)) {
      fail(
        'json_forbidden_key',
        `The key "${displayValue(key, 40)}" is not allowed because it can tamper with object prototypes.`,
        'Remove or rename the key.',
        at,
        JSON.stringify(displayValue(key, 24)),
      );
    }
    if (frame.seen.has(key)) {
      fail(
        'json_duplicate_key',
        `The key "${displayValue(key, 40)}" appears twice in the same object.`,
        'Keep only one entry per key; a parser would silently use the last one.',
        at,
        JSON.stringify(displayValue(key, 24)),
      );
    }
    frame.seen.add(key);
    skipWhitespace();
    if (text.charAt(i) !== ':')
      fail(
        'json_syntax',
        `Expected ":" after the key but found ${describe()}.`,
        'Put a colon between a key and its value.',
      );
    i += 1;
    frame.key = key;
  };

  const attach = (value: unknown): void => {
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      done = true;
    } else if (top.kind === 'array') {
      top.value.push(value);
    } else {
      top.value[top.key] = value;
    }
  };

  const open = (frame: Frame): void => {
    if (stack.length + 1 > limits.maxDepth) {
      fail(
        'json_too_deep',
        `The JSON is nested more than ${limits.maxDepth} levels deep.`,
        'A case bundle needs only a few levels; flatten the structure.',
      );
    }
    stack.push(frame);
  };

  const readPrimitive = (): void => {
    const c = text.charAt(i);
    if (c === '"') return attach(readString());
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return attach(value);
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) {
      return fail(
        'json_syntax',
        `Unexpected ${describe()} where a value was expected.`,
        c === "'"
          ? 'JSON strings need double quotes, not single quotes.'
          : c === ',' || c === ']' || c === '}'
            ? 'Check for a trailing or doubled comma.'
            : 'Values are strings, numbers, true, false, null, arrays or objects.',
      );
    }
    const number = Number(m[0]);
    if (!Number.isFinite(number)) {
      return fail(
        'json_invalid_number',
        'A number is too large to represent.',
        'Use a smaller number or write it as a string.',
      );
    }
    i += m[0].length;
    const next = text.charAt(i);
    if (next !== '' && !/[\s,\]}]/.test(next)) {
      return fail(
        'json_syntax',
        `Unexpected ${describe()} after a number.`,
        'Numbers cannot have leading zeros, a trailing dot or extra characters.',
      );
    }
    return attach(number);
  };

  try {
    while (!done) {
      skipWhitespace();
      if (i >= n)
        fail(
          'json_syntax',
          'The JSON ends unexpectedly.',
          'Check for a missing closing bracket, brace or quote.',
        );
      nodes += 1;
      if (nodes > limits.maxNodes) {
        fail(
          'json_too_complex',
          `The JSON has more than ${limits.maxNodes} values.`,
          'Split the file or remove unneeded data.',
        );
      }
      const c = text.charAt(i);
      if (c === '{') {
        const frame: ObjectFrame = { kind: 'object', value: {}, seen: new Set(), key: '' };
        open(frame);
        i += 1;
        skipWhitespace();
        if (text.charAt(i) === '}') {
          i += 1;
          stack.pop();
          attach(frame.value);
        } else {
          readKey(frame);
          continue;
        }
      } else if (c === '[') {
        const frame: ArrayFrame = { kind: 'array', value: [] };
        open(frame);
        i += 1;
        skipWhitespace();
        if (text.charAt(i) === ']') {
          i += 1;
          stack.pop();
          attach(frame.value);
        } else {
          continue;
        }
      } else {
        readPrimitive();
      }

      // A value was completed: close containers or move to the next entry until a value is expected.
      while (!done) {
        skipWhitespace();
        const top = stack[stack.length - 1];
        if (!top) break;
        const next = text.charAt(i);
        if (next === ',') {
          i += 1;
          if (top.kind === 'object') readKey(top);
          break;
        }
        const closer = top.kind === 'array' ? ']' : '}';
        if (i >= n) {
          fail(
            'json_syntax',
            'The JSON ends unexpectedly.',
            'Check for a missing closing bracket, brace or quote.',
          );
        }
        if (next !== closer) {
          fail(
            'json_syntax',
            `Expected "," or "${closer}" but found ${describe()}.`,
            'Separate items with commas and close every bracket and brace.',
          );
        }
        i += 1;
        stack.pop();
        attach(top.value);
      }
    }
    skipWhitespace();
    if (i < n)
      fail(
        'json_syntax',
        `Unexpected ${describe()} after the end of the JSON value.`,
        'A file must contain exactly one JSON value.',
      );
    return { ok: true, value: root, nodes };
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    const { line, column } = locate(text, error.at);
    return {
      ok: false,
      error: {
        code: error.code,
        message: `${error.message} (line ${line}, column ${column})`,
        hint: error.hint,
        path: formatJsonPath(stack),
        line,
        column,
        received: error.received === null ? null : displayValue(error.received, 24) || null,
      },
    };
  }
}

/** 1-based line and column of a character offset. */
function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: end - lastBreak };
}
