import { IngestParseError } from './errors';

/** Every bound the parsers enforce. Hostile input must never exceed these in time or memory. */
export interface ParserLimits {
  /** Pasted transcript size in UTF-16 code units; mirrors the paste request limit. */
  maxTranscriptChars: number;
  /** CSV and JSON payload size in UTF-8 bytes; mirrors the default upload limit. */
  maxPayloadBytes: number;
  maxLines: number;
  maxEvents: number;
  /** Event body length accepted by the case bundle schema. */
  maxBodyChars: number;
  maxParticipants: number;
  maxWarnings: number;
  maxErrors: number;
  maxCsvRows: number;
  maxCsvColumns: number;
  maxCsvFieldChars: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
}

export const DEFAULT_PARSER_LIMITS: Readonly<ParserLimits> = {
  maxTranscriptChars: 200_000,
  maxPayloadBytes: 2_097_152,
  maxLines: 20_000,
  maxEvents: 2_000,
  maxBodyChars: 20_000,
  maxParticipants: 30,
  maxWarnings: 100,
  maxErrors: 50,
  maxCsvRows: 2_000,
  maxCsvColumns: 40,
  maxCsvFieldChars: 20_000,
  maxJsonDepth: 16,
  maxJsonNodes: 200_000,
};

/** Callers may lower a limit but never raise it past these ceilings. */
export const HARD_PARSER_LIMITS: Readonly<ParserLimits> = {
  maxTranscriptChars: 1_000_000,
  maxPayloadBytes: 8_388_608,
  maxLines: 100_000,
  maxEvents: 2_000,
  maxBodyChars: 20_000,
  maxParticipants: 30,
  maxWarnings: 200,
  maxErrors: 200,
  maxCsvRows: 2_000,
  maxCsvColumns: 100,
  maxCsvFieldChars: 20_000,
  maxJsonDepth: 32,
  maxJsonNodes: 1_000_000,
};

const LIMIT_KEYS = Object.keys(DEFAULT_PARSER_LIMITS) as (keyof ParserLimits)[];

/** Merges overrides over the defaults; invalid or too-generous overrides are programmer errors. */
export function resolveLimits(overrides?: Partial<ParserLimits>): ParserLimits {
  const resolved: ParserLimits = { ...DEFAULT_PARSER_LIMITS };
  if (!overrides) return resolved;
  for (const key of LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new IngestParseError(
        'invalid_options',
        `Parser limit "${key}" must be a positive integer (received ${String(value)}).`,
      );
    }
    if (value > HARD_PARSER_LIMITS[key]) {
      throw new IngestParseError(
        'invalid_options',
        `Parser limit "${key}" cannot exceed ${HARD_PARSER_LIMITS[key]} (received ${value}).`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}
