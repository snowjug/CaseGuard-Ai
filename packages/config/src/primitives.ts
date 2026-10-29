import { z } from 'zod';

/**
 * Deployment templates emit empty strings for optional settings, so unset, empty and whitespace-only
 * values all mean "not provided".
 */
export const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', '0', 'no', 'off']);

export const envString = (max: number) =>
  z.preprocess(blankToUndefined, z.string().max(max).optional());

export const envEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(blankToUndefined, z.enum(values).optional());

export const envBoolean = () =>
  z.preprocess((value) => {
    const cleaned = blankToUndefined(value);
    if (typeof cleaned !== 'string') return cleaned;
    const lower = cleaned.toLowerCase();
    if (TRUE_WORDS.has(lower)) return true;
    if (FALSE_WORDS.has(lower)) return false;
    return cleaned;
  }, z.boolean().optional());

export const envInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());

export const envNumber = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().min(min).max(max).optional());

/** Splits a comma-separated list, dropping empty entries. */
export const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
