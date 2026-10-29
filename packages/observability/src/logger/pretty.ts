/** Anything with a synchronous `write(line)`: pino's destination contract. */
export interface LogDestination {
  write(chunk: string): void;
}

/** Options for `createPrettyDestination`. */
export interface PrettyOptions {
  /** Colourise the level with ANSI escapes. Default false so output stays diff-friendly. */
  readonly color?: boolean;
}

const LEVEL_COLORS: Readonly<Record<string, string>> = {
  trace: '90',
  debug: '34',
  info: '32',
  warn: '33',
  error: '31',
  fatal: '35',
};

/** Fields shown in the header or already implied by it; everything else is printed after the message. */
const HEADER_FIELDS: ReadonlySet<string> = new Set([
  'level',
  'time',
  'msg',
  'service',
  'version',
  'env',
  'commit',
  'err',
]);
const CORRELATION_FIELDS: readonly string[] = [
  'requestId',
  'traceId',
  'spanId',
  'tenantId',
  'userId',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /^[\w.:/@-]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? 'undefined';
}

function formatErrorBlock(err: unknown): string {
  if (!isRecord(err)) return '';
  const type = typeof err.type === 'string' ? err.type : 'Error';
  const message = typeof err.message === 'string' ? err.message : '';
  const head = `\n    ${type}: ${message}`;
  const stack = typeof err.stack === 'string' ? err.stack : '';
  const frames = stack
    .split('\n')
    .slice(1)
    .map((frame) => `\n  ${frame.trimEnd()}`)
    .join('');
  return `${head}${frames}`;
}

function formatRecord(record: Record<string, unknown>, color: boolean): string {
  const level = typeof record.level === 'string' ? record.level : 'info';
  const time = typeof record.time === 'string' ? record.time.slice(11, 23) : '';
  const label = level.toUpperCase().padEnd(5);
  const paint = color ? `\u001b[${LEVEL_COLORS[level] ?? '0'}m${label}\u001b[0m` : label;
  const service = typeof record.service === 'string' ? ` (${record.service})` : '';
  const message = typeof record.msg === 'string' ? record.msg : '';
  const correlation = CORRELATION_FIELDS.filter((key) => record[key] !== undefined).map(
    (key) => `${key}=${formatValue(record[key])}`,
  );
  const rest = Object.keys(record)
    .filter((key) => !HEADER_FIELDS.has(key) && !CORRELATION_FIELDS.includes(key))
    .map((key) => `${key}=${formatValue(record[key])}`);
  const fields = [...correlation, ...rest].join(' ');
  return `${time} ${paint}${service} ${message}${fields === '' ? '' : ` ${fields}`}${formatErrorBlock(record.err)}\n`;
}

/**
 * Wraps a destination with a human-readable one-line-per-record renderer, for local development
 * only (no pino-pretty or worker transport needed). It formats the already-scrubbed JSON line pino
 * produced, so it cannot reintroduce anything redaction removed.
 */
export function createPrettyDestination(
  target: LogDestination,
  options: PrettyOptions = {},
): LogDestination {
  const color = options.color === true;
  return {
    write(chunk: string): void {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Not a JSON record (a foreign writer on the same stream): pass it through untouched.
          target.write(`${line}\n`);
          continue;
        }
        target.write(isRecord(parsed) ? formatRecord(parsed, color) : `${line}\n`);
      }
    },
  };
}
