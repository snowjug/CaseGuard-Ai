import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator, RandomSource } from '../types';
import { systemClock } from '../types';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const cryptoRandom: RandomSource = () => {
  const bytes = randomBytes(4);
  return bytes.readUInt32BE(0) / 4_294_967_296;
};

/** Generates `<prefix>_<26-char ULID-like>` identifiers (10 time chars + 16 random chars). */
export function createIdGenerator(
  options: { clock?: Clock; random?: RandomSource } = {},
): IdGenerator {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  return {
    next(prefix: string): string {
      let time = Math.max(0, Math.floor(clock.nowMs()));
      let timePart = '';
      for (let i = 0; i < 10; i++) {
        timePart = CROCKFORD.charAt(time % 32) + timePart;
        time = Math.floor(time / 32);
      }
      let randomPart = '';
      for (let i = 0; i < 16; i++) randomPart += CROCKFORD.charAt(Math.floor(random() * 32) % 32);
      return `${prefix}_${timePart}${randomPart}`;
    },
  };
}

export const toIso = (ms: number): string => new Date(ms).toISOString();
