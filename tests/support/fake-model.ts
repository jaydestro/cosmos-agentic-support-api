import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A loopback stand-in for an Azure OpenAI deployment. It exists so the model client, the investigator and the
 * live path through the host can be exercised without a paid model: it answers whatever a test scripts and
 * records what it received. It proves behaviour against the documented wire shape, not against a real model.
 */

export interface FakeModelRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly text: string;
  /** The body parsed as JSON, or `undefined` when it was not JSON. */
  readonly json: unknown;
}

export type FakeModelReply =
  | { readonly kind: 'json'; readonly body: unknown; readonly status?: number; readonly headers?: Record<string, string>; readonly delayMs?: number }
  | { readonly kind: 'text'; readonly text: string; readonly status?: number; readonly headers?: Record<string, string> }
  | { readonly kind: 'redirect'; readonly location: string }
  /** Closes the connection after the request was received, as a dropped connection would. */
  | { readonly kind: 'drop' }
  /** Accepts the request and never answers. */
  | { readonly kind: 'hang' };

export type FakeModelScript = (request: FakeModelRequest, index: number) => FakeModelReply;

export interface FakeModel {
  /** `http://127.0.0.1:<port>`; this is what `LIVE_MODEL_ENDPOINT` takes. */
  readonly origin: string;
  /** `<origin>/openai/v1`, the base the client appends `/chat/completions` to. */
  readonly baseUrl: string;
  readonly requests: readonly FakeModelRequest[];
  /** Answers the next requests with these replies in order; after the last, every request gets a 500. */
  reply(...replies: FakeModelReply[]): void;
  script(script: FakeModelScript): void;
  reset(): void;
  close(): Promise<void>;
}

export interface FakeToolCall {
  readonly id?: string;
  readonly name: string;
  /** An object is serialised; a string is sent as is, which lets a test send malformed arguments. */
  readonly arguments: unknown;
}

export interface CompletionOptions {
  readonly content?: string | null;
  readonly refusal?: string | null;
  readonly toolCalls?: readonly FakeToolCall[];
  readonly finishReason?: string;
  /** `null` omits the usage block. */
  readonly usage?: { readonly prompt: number; readonly completion: number } | null;
}

/** A Chat Completions response body in the shape the Azure OpenAI v1 API documents. */
export function completionBody(options: CompletionOptions = {}): Record<string, unknown> {
  const toolCalls = options.toolCalls ?? [];
  const usage = options.usage === undefined ? { prompt: 400, completion: 60 } : options.usage;
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: 'fake',
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: options.content === undefined ? null : options.content,
          refusal: options.refusal === undefined ? null : options.refusal,
          ...(toolCalls.length === 0
            ? {}
            : {
                tool_calls: toolCalls.map((call, index) => ({
                  id: call.id ?? `call_${String(index + 1)}`,
                  type: 'function',
                  function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) },
                })),
              }),
        },
      },
    ],
    ...(usage === null ? {} : { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } }),
  };
}

export const jsonReply = (body: unknown, extra: { status?: number; headers?: Record<string, string>; delayMs?: number } = {}): FakeModelReply => ({
  kind: 'json',
  body,
  ...extra,
});

export const completionReply = (options: CompletionOptions = {}): FakeModelReply => jsonReply(completionBody(options));

export const errorReply = (status: number, headers: Record<string, string> = {}): FakeModelReply =>
  jsonReply({ error: { code: 'fake_error', message: 'The fake model refused this request.', param: null, type: 'fake' } }, { status, headers });

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function startFakeModel(): Promise<FakeModel> {
  const requests: FakeModelRequest[] = [];
  const sockets = new Set<Socket>();
  let current: FakeModelScript = () => ({ kind: 'json', status: 500, body: { error: { code: 'script_exhausted' } } });

  const server: Server = createServer((request, response) => {
    void (async () => {
      const text = await readBody(request);
      const recorded: FakeModelRequest = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, text, json: parseJson(text) };
      const index = requests.length;
      requests.push(recorded);
      const reply = current(recorded, index);
      switch (reply.kind) {
        case 'drop':
          request.socket.destroy();
          return;
        case 'hang':
          return;
        case 'redirect':
          response.writeHead(302, { location: reply.location });
          response.end();
          return;
        case 'text':
          response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
          response.end(reply.text);
          return;
        case 'json':
          if (reply.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
          response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
          response.end(JSON.stringify(reply.body));
      }
    })().catch(() => request.socket.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    baseUrl: `${origin}/openai/v1`,
    requests,
    reply(...replies) {
      const base = requests.length;
      current = (_request, index) => replies[index - base] ?? { kind: 'json', status: 500, body: { error: { code: 'script_exhausted' } } };
    },
    script(script) {
      current = script;
    },
    reset() {
      requests.length = 0;
      current = () => ({ kind: 'json', status: 500, body: { error: { code: 'script_exhausted' } } });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A loopback address with nothing listening on it, for a connection that is refused. */
export async function closedLoopbackOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${String(port)}`;
}
