import type { SearchHit } from '../src/db';

/** Shared constants and builders of the search unit tests (not a test file itself). */

export const CONTOSO = 'tenant_contoso_support';
export const ENDPOINT = 'https://example-search.search.windows.net';
export const INDEX = 'caseguard-test';

export const hit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  type: 'case',
  id: 'case_alpha',
  caseId: 'case_alpha',
  title: 'Sign-in outage',
  snippet: 'Users cannot sign in.',
  score: 0.5,
  ...overrides,
});
