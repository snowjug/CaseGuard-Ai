export {
  AZURE_SEARCH_API_VERSION,
  AZURE_SEARCH_SCOPE,
  AZURE_SEARCH_TIMEOUT_MS,
  SearchProviderError,
  buildSearchUrl,
  createAzureSearchClient,
  mapDocuments,
  tenantFilter,
  type AzureSearchClient,
  type AzureSearchOptions,
  type AzureSearchOutcome,
  type AzureSearchRequest,
  type AzureSearchSettings,
  type SearchCredential,
  type SearchProviderFailure,
} from './azure-ai-search';
export { hrefFor, toSearchResult } from './results';
export {
  createSearchService,
  normalizeQuery,
  type SearchContext,
  type SearchRequest,
  type SearchService,
  type SearchServiceOptions,
} from './search-service';
export { AZURE_SEARCH_VALIDATION_NOTE } from './validation-note';
