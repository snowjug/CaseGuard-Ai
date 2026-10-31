import { request as nodeRequest } from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Names and values as they arrived, in their original case. */
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

export interface RawRequestOptions {
  readonly origin: string;
  readonly method?: string;
  readonly path: string;
  /** An array value sends the header once per entry (repeated header lines). */
  readonly headers?: Readonly<Record<string, string | string[]>>;
  readonly body?: string | Buffer;
  readonly timeoutMs?: number;
}

/**
 * A request with exactly the headers given, over Node's http client: Playwright's request API normalises headers and
 * cannot send one header twice, and the client-address checks need both. Asks for an uncompressed answer.
 */
export function rawRequest(options: RawRequestOptions): Promise<RawResponse> {
  const url = new URL(options.origin);
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { 'accept-encoding': 'identity', ...options.headers },
        agent: false,
        timeout: options.timeoutMs ?? 60_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error(`${options.path} timed out`)));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** How many times a header was sent or received (case-insensitive), counted from the raw header list. */
export function headerCount(rawHeaders: readonly string[], name: string): number {
  return rawHeaders.filter(
    (entry, index) => index % 2 === 0 && entry.toLowerCase() === name.toLowerCase(),
  ).length;
}
