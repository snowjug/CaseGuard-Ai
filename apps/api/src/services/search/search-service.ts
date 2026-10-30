import type { SearchConfig } from '@caseguard/config';
import type { SearchResult } from '@caseguard/schemas';
import type { SearchHit } from '../../db';
import { ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import {
  SearchProviderError,
  createAzureSearchClient,
  type AzureSearchClient,
  type AzureSearchOutcome,
  type AzureSearchSettings,
} from './azure-ai-search';
import { toValidResults } from './results';

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

/** One count per dropped document or hit, as `caseguard_errors_total{component="search",code=...}`. */
function recordDiscarded(ctx: SearchContext, code: string, count: number): void {
  for (let index = 0; index < count; index += 1) ctx.metrics.recordError('search', code);
}

/** Says, by count only, how many documents of the external index could not be used. */
function reportDiscardedDocuments(ctx: SearchContext, outcome: AzureSearchOutcome): void {
  if (outcome.droppedForeignTenant > 0) {
    ctx.logger.error(
      { discarded: outcome.droppedForeignTenant },
      'Azure AI Search returned documents of another tenant; they were discarded',
    );
    recordDiscarded(ctx, 'foreign_tenant_document', outcome.droppedForeignTenant);
  }
  if (outcome.droppedInvalid > 0) {
    ctx.logger.warn(
      { discarded: outcome.droppedInvalid },
      'Azure AI Search returned malformed documents; they were discarded',
    );
    recordDiscarded(ctx, 'invalid_document', outcome.droppedInvalid);
  }
}

/**
 * Global search over the caller's tenant. The built-in lexical search is the default. When
 * `SEARCH_PROVIDER=azure-ai-search` the external index is tried first (3 s deadline) and any failure
 * falls back to the lexical search; the fallback is visible only in the retrieval metric
 * (`provider=azure-ai-search, outcome=fallback`), never in the response. The query text is never logged.
 *
 * Whatever the provider returns is checked against the result contract before it is answered: a hit that
 * does not satisfy it is dropped (counted in a warning log and `caseguard_errors_total`), never allowed
 * to fail the response, and the limit applies to the hits that are left. An index that answers with
 * documents but none that can be used counts as a failure, so the caller gets the lexical results.
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

  function fallBack(ctx: SearchContext, started: number, failure: string, message: string): null {
    ctx.metrics.recordRetrieval('azure-ai-search', 'fallback', monotonic() - started);
    ctx.logger.warn({ failure }, message);
    return null;
  }

  async function tryAzure(
    ctx: SearchContext,
    settings: AzureSearchSettings,
    request: SearchRequest,
  ): Promise<SearchHit[] | null> {
    const started = monotonic();
    let outcome: AzureSearchOutcome;
    try {
      outcome = await azureClient(settings).search({
        tenantId: ctx.auth.tenantId,
        text: request.text,
        limit: request.limit,
        signal: ctx.signal,
      });
    } catch (error) {
      // A client that has gone away needs no answer and no fallback; nothing is delivered either way.
      if (ctx.signal.aborted) return [];
      const failure = error instanceof SearchProviderError ? error.failure : 'unexpected';
      return fallBack(ctx, started, failure, 'Azure AI Search failed; using lexical search');
    }
    reportDiscardedDocuments(ctx, outcome);
    const unusable =
      outcome.hits.length === 0 && outcome.droppedInvalid + outcome.droppedForeignTenant > 0;
    if (unusable) {
      return fallBack(
        ctx,
        started,
        'no_usable_documents',
        'Azure AI Search returned no usable documents; using lexical search',
      );
    }
    ctx.metrics.recordRetrieval('azure-ai-search', 'ok', monotonic() - started);
    return outcome.hits;
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
      const { results, discarded } = toValidResults(hits, request.limit);
      if (discarded > 0) {
        ctx.logger.warn(
          { provider: external === null ? 'lexical' : 'azure-ai-search', discarded },
          'Search hits that do not satisfy the result contract were discarded',
        );
        recordDiscarded(ctx, 'invalid_result', discarded);
      }
      return results;
    },
  };
}
