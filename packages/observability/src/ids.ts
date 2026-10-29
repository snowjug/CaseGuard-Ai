import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { systemClock, type Clock } from './clock';

/** Crockford base32: no I, L, O, U, so ids are unambiguous when read aloud or copied by hand. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Source of random bytes. Inject a deterministic source in tests. */
export type RandomBytes = (size: number) => Uint8Array;

/** Cryptographically secure bytes from `node:crypto`; the default for ids and trace ids. */
export const secureRandomBytes: RandomBytes = (size) => nodeRandomBytes(size);

/** Options for `createIdGenerator`. */
export interface IdGeneratorOptions {
  /** Wall clock for the time-sortable prefix of the id. */
  readonly now?: Clock;
  /** Random source for the 80-bit suffix. Defaults to a cryptographically secure source. */
  readonly randomBytes?: RandomBytes;
}

function encodeTime(epochMs: number): string {
  // Clamp instead of throwing: id generation sits on the request path and must not fail on a bad clock.
  let remaining = Number.isFinite(epochMs)
    ? Math.min(Math.max(0, Math.trunc(epochMs)), MAX_TIME)
    : 0;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ALPHABET.charAt(remaining % 32) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length < RANDOM_BYTES) {
    throw new RangeError(`Random source returned ${bytes.length} bytes, expected ${RANDOM_BYTES}`);
  }
  let accumulator = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    accumulator = (accumulator << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((accumulator >>> (bits - 5)) & 31);
      bits -= 5;
    }
    accumulator &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Factory for ids shaped `<prefix>_<26-char ULID-like>` (48-bit time + 80 bits of randomness),
 * matching the platform id convention so they satisfy `IdSchema`.
 */
export function createIdGenerator(prefix: string, options: IdGeneratorOptions = {}): () => string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      'Id prefix must be lower-case letters, digits or "_" and at most 32 characters',
    );
  }
  const now = options.now ?? systemClock;
  const random = options.randomBytes ?? secureRandomBytes;
  return () => `${prefix}_${encodeTime(now())}${encodeRandom(random(RANDOM_BYTES))}`;
}

/** Lower-case hex string of `byteLength` random bytes. */
export function randomHex(byteLength: number, random: RandomBytes = secureRandomBytes): string {
  const bytes = random(byteLength);
  if (bytes.length < byteLength) {
    throw new RangeError(`Random source returned ${bytes.length} bytes, expected ${byteLength}`);
  }
  let out = '';
  for (let i = 0; i < byteLength; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
