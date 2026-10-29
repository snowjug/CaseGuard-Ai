import type { SearchConfig } from '@caseguard/config';
import type { SearchResult } from '@caseguard/schemas';
import type { SearchHit } from '../../db';
import { ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import {
  SearchProviderError,
  createAzureSearchClient,
  type AzureSearchClient,
  type AzureSearchSettings,
} from './azure-ai-search';
import { toSearchResult } from './results';

export type SearchContext = Pick<
  RequestContext,
  'repos' | 'auth' | 'metrics' | 'logger' | 'signal'
> & { readonly config: { readonly search: SearchConfig } };

export interface SearchRequest {
  readonly text: string;
  readonly limit: number;
}

export interface SearchService {
  search(ctx: SearchContext, request: SearchRequest): Promise<SearchResult[]>;
}

export interface SearchServiceOptions {
  /** Builds the Azure AI Search client for the configured service (tests inject a fake one). */
  readonly createAzureClient?: (settings: AzureSearchSettings) => AzureSearchClient;
  /** Monotonic milliseconds for retrieval-latency metrics; defaults to `performance.now`. */
  readonly monotonicMs?: () => number;
}

const MIN_QUERY_CHARS = 2;

/** Control characters become blanks and runs of blanks collapse, so `"  "` is as empty as `""`. */
export function normalizeQuery(text: string): string {
  const cleaned = Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (Array.from(cleaned).length < MIN_QUERY_CHARS) {
    throw new ValidationFailedError('The search text is too short', [
      { path: 'query.q', message: `Enter at least ${MIN_QUERY_CHARS} characters.` },
    ]);
  }
  return cleaned;
}

/**
 * Global search over the caller's tenant. The built-in lexical search is the default. When
 * `SEARCH_PROVIDER=azure-ai-search` the external index is tried first (3 s deadline) and any failure
 * falls back to the lexical search; the fallback is visible only in the retrieval metric
 * (`provider=azure-ai-search, outcome=fallback`), never in the response. The query text is never logged.
 */
export function createSearchService(options: SearchServiceOptions = {}): SearchService {
  const monotonic = options.monotonicMs ?? (() => performance.now());
  const makeClient = options.createAzureClient ?? ((settings) => createAzureSearchClient(settings));
  let azure: { readonly key: string; readonly client: AzureSearchClient } | null = null;

  function azureClient(settings: AzureSearchSettings): AzureSearchClient {
    const key = `${settings.endpoint}\n${settings.index}`;
    if (azure?.key !== key) azure = { key, client: makeClient(settings) };
    return azure.client;
  }

  async function tryAzure(
    ctx: SearchContext,
    settings: AzureSearchSettings,
    request: SearchRequest,
  ): Promise<SearchHit[] | null> {
    const started = monotonic();
    try {
      const outcome = await azureClient(settings).search({
        tenantId: ctx.auth.tenantId,
        text: request.text,
        limit: request.limit,
        signal: ctx.signal,
      });
      ctx.metrics.recordRetrieval('azure-ai-search', 'ok', monotonic() - started);
      if (outcome.droppedForeignTenant > 0) {
        ctx.logger.error(
          { discarded: outcome.droppedForeignTenant },
          'Azure AI Search returned documents of another tenant; they were discarded',
        );
      }
      if (outcome.droppedInvalid > 0) {
        ctx.logger.warn(
          { discarded: outcome.droppedInvalid },
          'Azure AI Search returned malformed documents; they were discarded',
        );
      }
      return outcome.hits;
    } catch (error) {
      // A client that has gone away needs no answer and no fallback; nothing is delivered either way.
      if (ctx.signal.aborted) return [];
      ctx.metrics.recordRetrieval('azure-ai-search', 'fallback', monotonic() - started);
      ctx.logger.warn(
        { failure: error instanceof SearchProviderError ? error.failure : 'unexpected' },
        'Azure AI Search failed; using lexical search',
      );
      return null;
    }
  }

  async function lexical(ctx: SearchContext, request: SearchRequest): Promise<SearchHit[]> {
    const started = monotonic();
    try {
      const hits = await ctx.repos.search.query({ text: request.text, limit: request.limit });
      ctx.metrics.recordRetrieval('lexical', 'ok', monotonic() - started);
      return hits;
    } catch (error) {
      ctx.metrics.recordRetrieval('lexical', 'error', monotonic() - started);
      throw error;
    }
  }

  return {
    async search(ctx, request) {
      const text = normalizeQuery(request.text);
      const bounded = { text, limit: request.limit };
      const configured = ctx.config.search;
      const external =
        configured.provider === 'azure-ai-search'
          ? await tryAzure(ctx, { endpoint: configured.endpoint, index: configured.index }, bounded)
          : null;
      const hits = external ?? (await lexical(ctx, bounded));
      return hits.slice(0, request.limit).map(toSearchResult);
    },
  };
}
