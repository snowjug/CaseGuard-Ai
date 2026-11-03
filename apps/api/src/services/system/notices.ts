import { AZURE_VALIDATION_NOTE, SCRIPTED_VALIDATION_NOTE } from '@caseguard/ai';
import type { AppConfig } from '@caseguard/config';
import { AZURE_BLOB_VALIDATION_NOTE } from '../../storage';
import { AZURE_SEARCH_VALIDATION_NOTE } from '../search/validation-note';

/**
 * Honesty notices for the System Health page: what each configured integration actually is and how far
 * it has been validated. Stand-in dependencies (local object store, lexical search, deterministic
 * provider) are additionally labelled by the health registry itself.
 */
export function integrationNotices(config: AppConfig): string[] {
  const notices: string[] = [];

  notices.push(
    config.ai.provider === 'deterministic'
      ? 'AI reasoning runs on the deterministic evidence engine. No cloud language model is connected; model values are simulated or estimated.'
      : config.ai.provider === 'scripted'
        ? SCRIPTED_VALIDATION_NOTE
        : AZURE_VALIDATION_NOTE,
  );
  notices.push(
    config.search.provider === 'azure-ai-search'
      ? AZURE_SEARCH_VALIDATION_NOTE
      : 'Search is the built-in lexical (keyword) search over the data of this tenant. Azure AI Search is not configured.',
  );
  if (config.storage.provider === 'azure-blob') notices.push(AZURE_BLOB_VALIDATION_NOTE);
  notices.push(
    config.auth.mode === 'dev'
      ? 'Development sign-in is active: personas are not real identities. It is allowed only when APP_ENV is local or test.'
      : 'Microsoft Entra ID sign-in is implemented and unit-tested with locally generated keys only; it has not been exercised against a live tenant.',
  );
  if (config.database.kind === 'postgres') {
    notices.push(
      'PostgreSQL is configured. The automated tests of this build ran against in-process PGlite; the PostgreSQL path (pooling, TLS, Entra token authentication) has not been exercised.',
    );
  }
  return notices;
}
