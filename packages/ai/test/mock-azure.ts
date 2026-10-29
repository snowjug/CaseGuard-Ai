import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
  receivedAtMs: number;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** Wait before answering. */
  delayMs?: number;
  /** Never answer (until the server stops): used for timeout and cancellation tests. */
  hold?: boolean;
  /** Close the socket without a response. */
  destroy?: boolean;
}

export type ReplyStep = MockReply | ((request: RecordedRequest, call: number) => MockReply);

/**
 * Local stand-in for the Azure OpenAI chat-completions endpoint (node:http on a loopback port).
 * Tests never contact a real service.
 */
export class MockAzureServer {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: ReplyStep[] = [];
  private fallback: ReplyStep = { status: 500, json: { error: { code: 'unscripted' } } };
  private constructor(private readonly server: Server) {}

  static async start(): Promise<MockAzureServer> {
    let mock: MockAzureServer | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let body: unknown = null;
        try {
          body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
        } catch {
          body = null;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          rawBody,
          body,
          receivedAtMs: Date.now(),
        };
        const call = mock?.requests.length ?? 0;
        mock?.requests.push(recorded);
        const step = mock?.queue.shift() ?? mock?.fallback;
        const reply = typeof step === 'function' ? step(recorded, call) : (step ?? {});
        if (reply.destroy) {
          req.socket.destroy();
          return;
        }
        if (reply.hold) return;
        const send = (): void => {
          const payload = reply.text ?? JSON.stringify(reply.json ?? {});
          res.writeHead(reply.status ?? 200, {
            'content-type': 'application/json',
            ...reply.headers,
          });
          res.end(payload);
        };
        if (reply.delayMs) {
          const timer = setTimeout(send, reply.delayMs);
          res.on('close', () => clearTimeout(timer));
        } else {
          send();
        }
      });
    });
    mock = new MockAzureServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return mock;
  }

  get endpoint(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Replies are consumed in order; once the queue is empty the default reply is used. */
  enqueue(...steps: ReplyStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  setDefault(step: ReplyStep): this {
    this.fallback = step;
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
    this.fallback = { status: 500, json: { error: { code: 'unscripted' } } };
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface CompletionOptions {
  model?: string;
  finishReason?: string;
  usage?: { prompt: number; completion: number; cached?: number } | null;
  refusal?: string;
  toolCalls?: unknown[];
  extraChoice?: Record<string, unknown>;
}

/** A successful chat-completions reply whose message content is `content` (object or raw text). */
export function chatCompletion(content: unknown, options: CompletionOptions = {}): MockReply {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const usage = options.usage === undefined ? { prompt: 120, completion: 40 } : options.usage;
  return {
    status: 200,
    json: {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: options.model ?? 'gpt-mock-2026-01-01',
      choices: [
        {
          index: 0,
          finish_reason: options.finishReason ?? 'stop',
          message: {
            role: 'assistant',
            content: options.refusal || options.toolCalls ? null : text,
            ...(options.refusal ? { refusal: options.refusal } : {}),
            ...(options.toolCalls ? { tool_calls: options.toolCalls } : {}),
          },
          ...options.extraChoice,
        },
      ],
      ...(usage === null
        ? {}
        : {
            usage: {
              prompt_tokens: usage.prompt,
              completion_tokens: usage.completion,
              total_tokens: usage.prompt + usage.completion,
              prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
            },
          }),
    },
  };
}
