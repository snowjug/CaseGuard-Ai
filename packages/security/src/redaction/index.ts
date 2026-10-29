export type {
  CustomRedactionPattern,
  RedactionOptions,
  RedactionResult,
  RedactionValueResult,
} from './types';
export { DEFAULT_REDACTION_OPTIONS, SECRET_REDACTION_CATEGORIES, redactText } from './redact-text';
export { redactValue } from './redact-value';
export { createPseudonymState } from './pseudonyms';
export type { PseudonymCategory, PseudonymState } from './pseudonyms';
export { isNonRoutableIpv4, isReservedEmailDomain } from './synthetic';
export {
  MAX_CUSTOM_PATTERN_LENGTH,
  compileCustomPatterns,
  describeBacktrackingRisk,
} from './custom';
export type { CompiledCustomPatterns } from './custom';
export { placeholderFor } from './rules';
