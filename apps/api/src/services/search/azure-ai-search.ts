import { assertSafeOutboundUrl } from '@caseguard/security';
import { z } from 'zod';
import type { SearchHit } from '../../db';

/*
 * Optional Azure AI Search adapter for `search.global`.
 *
 * VALIDATION STATUS: implemented and validated against injected fakes (`fetch` and credential) only. It
 * has never been run against a live search service. The index must be populated outside this API (see
 * README.md for the document shape): `id` (the index key, unique across tenants), `tenantId`
 * (filterable), `type`, `entityId` (the CaseGuard id used in links), `caseId`, `title` and `snippet`.
 * Built-in lexical search stays the default and the automatic fallback (`search-service.ts`).
 *
 * Safety properties, each covered by a test:
 *  - the endpoint must be https on `*.search.windows.net` (`assertSafeOutboundUrl`), default port, no
 *    credentials, and redirects are never followed (the bearer token must not travel anywhere else);
 *  - the tenant `filter` is always part of the request, and every returned document is checked against
 *    the tenant again, so a misconfigured index cannot leak another tenant's documents;
 *  - the token comes from Microsoft Entra (`DefaultAzureCredential`, scope below), never from a key;
 *  - 3 s overall deadline, bounded response size, no query text or token in errors or logs.
 */

export const AZURE_SEARCH_API_VERSION = '2024-07-01';
export const AZURE_SEARCH_SCOPE = 'https://search.azure.com/.default';
export const AZURE_SEARCH_TIMEOUT_MS = 3_000;
export const AZURE_SEARCH_ALLOWED_HOSTS: readonly string[] = ['*.search.windows.net'];
const MAX_RESPONSE_BYTES = 1_000_000;
const INDEX_NAME = /^[a-z0-9][a-z0-9-]{1,127}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SELECTED_FIELDS = 'id,tenantId,type,entityId,caseId,title,snippet';

export type SearchProviderFailure =
  | 'unsafe_endpoint'
  | 'invalid_index'
  | 'invalid_tenant'
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'network'
  | 'http_error'
  | 'too_large'
  | 'invalid_response';

/** A failed call to the external index. The message carries no endpoint, token or query text. */
export class SearchProviderError extends Error {
  constructor(
    readonly failure: SearchProviderFailure,
    readonly status?: number,
  ) {
    super(
      `Azure AI Search request failed (${failure}${status === undefined ? '' : `, HTTP ${status}`})`,
    );
    this.name = 'SearchProviderError';
  }
}

/** The slice of an Azure credential this adapter uses (`DefaultAzureCredential` satisfies it). */
export interface SearchCredential {
  getToken(
    scope: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string } | null>;
}

export interface AzureSearchSettings {
  /** Search service origin, for example `https://<service>.search.windows.net`. */
  readonly endpoint: string;
  readonly index: string;
}

export interface AzureSearchOptions extends AzureSearchSettings {
  /** Defaults to `DefaultAzureCredential` (managed identity in Azure), created on first use. */
  readonly credential?: SearchCredential;
  /** Defaults to the global `fetch`, resolved at call time. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface AzureSearchRequest {
  readonly tenantId: string;
  readonly text: string;
  readonly limit: number;
  /** Aborts the call (client disconnected). The adapter adds its own deadline. */
  readonly signal?: AbortSignal | undefined;
}

export interface AzureSearchOutcome {
  readonly hits: SearchHit[];
  /** Documents discarded because they did not match the expected shape. */
  readonly droppedInvalid: number;
  /** Documents discarded because they belonged to another tenant (the index ignored the filter). */
  readonly droppedForeignTenant: number;
}

export interface AzureSearchClient {
  search(request: AzureSearchRequest): Promise<AzureSearchOutcome>;
}

const DocumentSchema = z.object({
  '@search.score': z.number().min(0).max(1e9),
  /** The index key. It must be unique across tenants, so it is not used in links. */
  id: z.string().min(1).max(300),
  tenantId: z.string().min(1).max(120),
  type: z.enum(['case', 'claim', 'hypothesis', 'skill', 'warning', 'event']),
  /** The CaseGuard id of the item, used to build its link. Falls back to `id` when the index has none. */
  entityId: z.string().min(1).max(120).nullable().optional(),
  caseId: z.string().min(1).max(120).nullable().optional(),
  title: z.string().max(2000),
  snippet: z.string().max(20_000).nullable().optional(),
});

const ResponseSchema = z.object({ value: z.array(z.unknown()).max(200) });

/** `https://<service>.search.windows.net/indexes/<index>/docs/search?api-version=...`, or a failure. */
export function buildSearchUrl(settings: AzureSearchSettings): URL {
  let base: URL;
  try {
    base = assertSafeOutboundUrl(settings.endpoint, { allowedHosts: AZURE_SEARCH_ALLOWED_HOSTS });
  } catch {
    throw new SearchProviderError('unsafe_endpoint');
  }
  if (!INDEX_NAME.test(settings.index)) throw new SearchProviderError('invalid_index');
  const url = new URL(`/indexes/${encodeURIComponent(settings.index)}/docs/search`, base.origin);
  url.searchParams.set('api-version', AZURE_SEARCH_API_VERSION);
  return url;
}

/** The OData filter that confines a query to one tenant. The id is validated and quote-escaped. */
export function tenantFilter(tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new SearchProviderError('invalid_tenant');
  return `tenantId eq '${tenantId.replaceAll("'", "''")}'`;
}

/** BM25 scores are unbounded; this keeps their order and maps them into [0, 1) like lexical scores. */
function normalizeScore(raw: number): number {
  return Math.round((raw / (1 + raw)) * 10_000) / 10_000;
}

/** Maps documents to hits, discarding malformed ones and anything of another tenant. */
export function mapDocuments(documents: readonly unknown[], tenantId: string): AzureSearchOutcome {
  const hits: SearchHit[] = [];
  let droppedInvalid = 0;
  let droppedForeignTenant = 0;
  for (const candidate of documents) {
    const parsed = DocumentSchema.safeParse(candidate);
    if (!parsed.success) {
      droppedInvalid += 1;
      continue;
    }
    const doc = parsed.data;
    if (doc.tenantId !== tenantId) {
      droppedForeignTenant += 1;
      continue;
    }
    const entityId = doc.entityId ?? doc.id;
    hits.push({
      type: doc.type,
      id: entityId,
      caseId: doc.type === 'skill' ? null : (doc.caseId ?? (doc.type === 'case' ? entityId : null)),
      title: doc.title,
      snippet: doc.snippet ?? '',
      score: normalizeScore(doc['@search.score']),
    });
  }
  return { hits, droppedInvalid, droppedForeignTenant };
}

/** The abort reason as an `Error` (a `DOMException` already is one), so rejections always carry an Error. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The search call was aborted');
}

/** Rejects as soon as `signal` aborts, for work (a credential) that may ignore the signal. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('The search call failed'));
      },
    );
  });
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SearchProviderError('too_large');
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SearchProviderError('invalid_response');
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    // The global stream types carry `any` chunks; the body of a fetch response is always bytes.
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done || chunk.value === undefined) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      // The stream is abandoned either way; a failure to cancel it changes nothing for the caller.
      await reader.cancel().catch(() => undefined);
      throw new SearchProviderError('too_large');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function asProviderError(error: unknown, deadline: AbortSignal): SearchProviderError {
  if (error instanceof SearchProviderError) return error;
  if (deadline.aborted) {
    const reason = deadline.reason as { name?: unknown } | undefined;
    return new SearchProviderError(reason?.name === 'TimeoutError' ? 'timeout' : 'aborted');
  }
  return new SearchProviderError('network');
}

export function createAzureSearchClient(options: AzureSearchOptions): AzureSearchClient {
  const timeoutMs = options.timeoutMs ?? AZURE_SEARCH_TIMEOUT_MS;
  let credential: SearchCredential | undefined = options.credential;

  async function credentialInUse(): Promise<SearchCredential> {
    if (credential === undefined) {
      const { DefaultAzureCredential } = await import('@azure/identity');
      credential = new DefaultAzureCredential();
    }
    return credential;
  }

  async function execute(
    request: AzureSearchRequest,
    deadline: AbortSignal,
  ): Promise<AzureSearchOutcome> {
    const url = buildSearchUrl(options);
    const filter = tenantFilter(request.tenantId);
    const token = await (
      await credentialInUse()
    ).getToken(AZURE_SEARCH_SCOPE, { abortSignal: deadline });
    if (token === null || token.token === '') throw new SearchProviderError('auth');

    const send = options.fetch ?? globalThis.fetch;
    const response = await send(url, {
      method: 'POST',
      // A redirect would carry the bearer token to another host.
      redirect: 'error',
      signal: deadline,
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        search: request.text,
        queryType: 'simple',
        searchMode: 'all',
        top: request.limit,
        filter,
        select: SELECTED_FIELDS,
        count: false,
      }),
    });
    if (!response.ok) throw new SearchProviderError('http_error', response.status);

    let payload: unknown;
    try {
      payload = JSON.parse(await readCapped(response, MAX_RESPONSE_BYTES));
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError('invalid_response');
    }
    const body = ResponseSchema.safeParse(payload);
    if (!body.success) throw new SearchProviderError('invalid_response');
    return mapDocuments(body.data.value, request.tenantId);
  }

  return {
    async search(request) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal =
        request.signal === undefined ? deadline : AbortSignal.any([deadline, request.signal]);
      try {
        return await raceAbort(execute(request, signal), signal);
      } catch (error) {
        throw asProviderError(error, signal);
      }
    },
  };
}
