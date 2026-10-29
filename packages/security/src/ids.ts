import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from './hashing';

/** Crockford base32: no I, L, O, U, so ids are unambiguous when read aloud or copied by hand. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

export interface IdOptions {
  /** Clock returning epoch milliseconds (or a Date). Inject a fixed clock in tests. */
  now?: () => number | Date;
  /** Uniform random source in [0, 1). Defaults to a cryptographically secure source. */
  random?: () => number;
}

function secureRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}

function assertPrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(prefix) || prefix.length > 32) {
    throw new TypeError(
      'Id prefix must be lower-case words joined by "_" and at most 32 characters',
    );
  }
}

function readClock(now: IdOptions['now']): number {
  const raw = now ? now() : Date.now();
  const ms = raw instanceof Date ? raw.getTime() : raw;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError('Clock must return epoch milliseconds that fit in 48 bits');
  }
  return ms;
}

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ALPHABET.charAt(remaining % 32) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function randomDigits(random: () => number): number[] {
  const digits: number[] = [];
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    const value = Math.floor(random() * 32);
    digits.push(Number.isFinite(value) ? Math.min(31, Math.max(0, value)) : 0);
  }
  return digits;
}

function encodeDigits(digits: readonly number[]): string {
  return digits.map((digit) => ALPHABET.charAt(digit)).join('');
}

/** Time-sortable id: `<prefix>_` plus a 26-character ULID (48-bit time, 80 bits of randomness). */
export function newId(prefix: string, options: IdOptions = {}): string {
  assertPrefix(prefix);
  const time = readClock(options.now);
  return `${prefix}_${encodeTime(time)}${encodeDigits(randomDigits(options.random ?? secureRandom))}`;
}

/**
 * Factory for ids that also sort correctly inside one millisecond: when the clock has not advanced,
 * the previous random part is incremented instead of redrawn. State lives in the returned closure.
 */
export function createMonotonicIdFactory(options: IdOptions = {}): (prefix: string) => string {
  const random = options.random ?? secureRandom;
  let lastTime = -1;
  let lastDigits: number[] = [];

  return (prefix: string): string => {
    assertPrefix(prefix);
    const clock = readClock(options.now);
    let time = Math.max(clock, lastTime);
    let digits: number[];
    if (time === lastTime) {
      digits = [...lastDigits];
      let index = RANDOM_CHARS - 1;
      while (index >= 0 && digits[index] === 31) {
        digits[index] = 0;
        index -= 1;
      }
      if (index < 0) {
        time += 1;
        digits = randomDigits(random);
      } else {
        digits[index] = (digits[index] ?? 0) + 1;
      }
    } else {
      digits = randomDigits(random);
    }
    lastTime = time;
    lastDigits = digits;
    return `${prefix}_${encodeTime(time)}${encodeDigits(digits)}`;
  };
}

function encodeBase32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Deterministic id for derived artefacts: the same `parts` always give the same id, so re-running
 * an analysis replaces its output instead of duplicating it. Collision space is 120 bits.
 */
export function stableId(prefix: string, ...parts: unknown[]): string {
  assertPrefix(prefix);
  const digest = Buffer.from(sha256Hex(canonicalJson(parts)), 'hex');
  return `${prefix}_${encodeBase32(digest.subarray(0, 15), 24)}`;
}
