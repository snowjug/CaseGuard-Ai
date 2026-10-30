import { DEFAULT_REDACTION_CONFIG, type RedactionCategory } from '@caseguard/schemas';
import type { RedactionOptions } from './types';

/** Defaults mirror the governance `DEFAULT_REDACTION_CONFIG` so settings and code cannot drift apart. */
export const DEFAULT_REDACTION_OPTIONS: Readonly<
  Required<Omit<RedactionOptions, 'customPatternBudget'>>
> = Object.freeze({
  enabledCategories: Object.freeze([...DEFAULT_REDACTION_CONFIG.enabledCategories]),
  customPatterns: Object.freeze([]),
  redactReservedValues: false,
});

/**
 * Credential categories only (no e-mail, IP or phone). Use these for logs and telemetry, where
 * client addresses and user ids are operationally useful but secrets must never appear.
 */
export const SECRET_REDACTION_CATEGORIES: readonly RedactionCategory[] = Object.freeze([
  'bearer_token',
  'api_key',
  'connection_string',
  'private_key',
  'password_assignment',
  'jwt',
  'github_token',
  'azure_storage_key',
]);
