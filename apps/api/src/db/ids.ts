import { randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so ids survive being read aloud or retyped. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

export type IdGenerator = (prefix: string) => string;

export interface IdGeneratorOptions {
  /** Millisecond clock; injected so tests are reproducible. */
  now?: () => number;
  /** Source of entropy (16 random bytes are needed per fresh millisecond). */
  random?: (size: number) => Uint8Array;
}

/**
 * Creates a generator of `<prefix>_<26-char ULID-like>` identifiers. Identifiers sort by creation
 * time and are strictly increasing within one generator, even inside the same millisecond.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((size: number) => randomBytes(size));
  let lastTime = -1;
  let lastRandom: number[] = [];

  return (prefix: string): string => {
    if (!PREFIX_PATTERN.test(prefix)) {
      throw new TypeError('Id prefixes must be 2-16 lower-case alphanumeric characters');
    }
    let time = Math.max(Math.floor(now()), lastTime);
    if (time === lastTime) {
      lastRandom = incrementBase32(lastRandom);
      if (lastRandom.length === 0) {
        // 2^80 ids inside one millisecond is unreachable in practice; borrow the next millisecond.
        time += 1;
        lastRandom = freshRandom(random);
      }
    } else {
      lastRandom = freshRandom(random);
    }
    lastTime = time;
    return `${prefix}_${encodeTime(time)}${lastRandom.map((digit) => CROCKFORD.charAt(digit)).join('')}`;
  };
}

function freshRandom(random: (size: number) => Uint8Array): number[] {
  const bytes = random(RANDOM_CHARS);
  const digits: number[] = [];
  for (let i = 0; i < RANDOM_CHARS; i += 1) digits.push((bytes[i] ?? 0) & 31);
  return digits;
}

/** Adds one to a base32 digit array; returns an empty array on overflow. */
function incrementBase32(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  return [];
}

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    const digit = remaining % 32;
    out = CROCKFORD.charAt(digit) + out;
    remaining = (remaining - digit) / 32;
  }
  return out;
}

/** True when `value` looks like an identifier produced by `createIdGenerator`. */
export function isGeneratedId(value: string, prefix?: string): boolean {
  const match = /^([a-z][a-z0-9]{1,15})_([0-9A-HJKMNP-TV-Z]{26})$/.exec(value);
  if (!match) return false;
  return prefix === undefined || match[1] === prefix;
}
