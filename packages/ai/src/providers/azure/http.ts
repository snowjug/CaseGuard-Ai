import { ProviderError } from '../../errors';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates the configured endpoint. Credentials are only ever sent over https; plain http is
 * accepted solely for loopback hosts (local mock servers in tests). No userinfo, query or path.
 */
export function parseEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderError('not_configured', 'The Azure OpenAI endpoint is not a valid URL.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ProviderError('not_configured', 'The Azure OpenAI endpoint must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProviderError(
      'not_configured',
      'The Azure OpenAI endpoint must not contain credentials.',
    );
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new ProviderError('not_configured', 'The Azure OpenAI endpoint must be a bare origin.');
  }
  return url.origin;
}

const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertDeployment(name: string): string {
  if (!DEPLOYMENT.test(name)) {
    throw new ProviderError('not_configured', 'The Azure OpenAI deployment name is not valid.');
  }
  return name;
}

export function chatCompletionsUrl(origin: string, deployment: string, apiVersion: string): string {
  return `${origin}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

/** Delay requested by the server, from `retry-after-ms`, `x-ms-retry-after-ms` or `retry-after`. */
export function retryAfterMs(headers: Headers, nowMs: number): number | null {
  const ms = headers.get('retry-after-ms') ?? headers.get('x-ms-retry-after-ms');
  if (ms !== null) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Reads a response body without ever holding more than `maxBytes` in memory. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ProviderError('response_too_large', 'The model response exceeded the size limit.', {
      status: response.status,
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done || chunk.value === undefined) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ProviderError('response_too_large', 'The model response exceeded the size limit.', {
        status: response.status,
      });
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export interface AzureErrorBody {
  code: string | null;
  innerCode: string | null;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Extracts only the short error codes from an error body; the message text is never kept. */
export function parseAzureError(text: string): AzureErrorBody {
  try {
    const body: unknown = JSON.parse(text);
    const error =
      typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
    if (typeof error !== 'object' || error === null) return { code: null, innerCode: null };
    const { code, innererror } = error as { code?: unknown; innererror?: unknown };
    const inner =
      typeof innererror === 'object' && innererror !== null
        ? (innererror as { code?: unknown }).code
        : null;
    const safe = (value: unknown): string | null =>
      typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
    return { code: safe(code), innerCode: safe(inner) };
  } catch {
    return { code: null, innerCode: null };
  }
}
