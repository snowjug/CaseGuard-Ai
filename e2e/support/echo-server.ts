import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the echo server saw of one request: exactly what an API behind the web tier would have received. */
export interface EchoedRequest {
  readonly method: string;
  readonly url: string;
  /** Header names are lower-case (Node's view); repeated headers are joined as Node joins them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Names and values as they arrived, in order and in their original case. */
  readonly rawHeaders: readonly string[];
  readonly bodyBytes: number;
  readonly bodySha256: string;
  readonly bodyText: string;
}

export interface EchoServer {
  readonly port: number;
  readonly origin: string;
  /** Every request received so far (newest last). */
  readonly requests: readonly EchoedRequest[];
  close(): Promise<void>;
}

/**
 * A tiny stand-in for the API: answers every request with the request it received (as JSON), so a test can see what
 * the web tier really forwards. Used as `API_INTERNAL_URL` of a second web instance.
 */
export async function startEchoServer(): Promise<EchoServer> {
  const requests: EchoedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const echoed: EchoedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        bodyBytes: body.length,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bodyText: body.subarray(0, 2_000).toString('utf8'),
      };
      requests.push(echoed);
      const payload = JSON.stringify(echoed);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-echo-server': 'caseguard-e2e',
        'x-request-id': String(request.headers['x-request-id'] ?? 'echo-generated'),
      });
      response.end(request.method === 'HEAD' ? undefined : payload);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on right now (the OS picks it; the race with another process is negligible). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
