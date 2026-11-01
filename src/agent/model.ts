import type { LiveModelConfig, LiveModelPricing } from '../config/env.ts';
import { TOOL_DEFINITIONS } from './tools.ts';

/**
 * The live-model port and its Azure OpenAI client.
 *
 * The client speaks the Chat Completions operation of the Azure OpenAI v1 API. Each call is one stateless
 * request, which is what per-call reservation and settlement need; the Responses API is the documented
 * alternative and is not used. The client fixes the tool list to the allowlisted definitions, so no caller can
 * widen what a model may ask for, and it never sends or stores case text beyond the messages it is given.
 * What comes back is untrusted: the response is parsed strictly and every size is bounded.
 *
 * Failures carry a short code and a classification and never a payload, because bodies can echo prompt text.
 */

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** The raw JSON text the model produced; it is validated by the tool box, never trusted here. */
  readonly arguments: string;
}

export type ModelMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly toolCalls: readonly ModelToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ModelCompletion {
  readonly content: string | null;
  readonly refusal: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: FinishReason;
  /** `null` when the response did not report usage; the caller then charges the reservation. */
  readonly usage: ModelUsage | null;
}

export interface ModelSpend {
  tokens: number;
  costMicroUsd: number;
}

export interface ModelClient {
  readonly deployment: string;
  readonly pricing: LiveModelPricing;
  /** An upper bound on what one call with these messages can use. It is reserved before the call is made. */
  estimate(messages: readonly ModelMessage[]): ModelSpend;
  /** The cost of reported usage at the configured prices. */
  priceOf(usage: ModelUsage): number;
  complete(messages: readonly ModelMessage[]): Promise<ModelCompletion>;
}

export type ModelErrorCode =
  | 'model_auth_failed'
  | 'model_unauthorized'
  | 'model_bad_request'
  | 'model_rate_limited'
  | 'model_unavailable'
  | 'model_timeout'
  | 'model_connection_failed'
  | 'model_response_invalid'
  | 'model_client_error';

/** `failed` is a call that did not reach the model; `ambiguous` may have been processed and billed. */
export type ModelFailureOutcome = 'failed' | 'ambiguous';

export class ModelFailure extends Error {
  readonly code: ModelErrorCode;
  readonly outcome: ModelFailureOutcome;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: ModelErrorCode, outcome: ModelFailureOutcome, retryable: boolean, retryAfterMs: number | null = null) {
    super(`The model call failed: ${code}.`);
    this.name = 'ModelFailure';
    this.code = code;
    this.outcome = outcome;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The part of an Azure Identity credential the client uses. */
export interface ModelCredential {
  getToken(scope: string): Promise<{ readonly token: string } | null>;
}

export interface ModelClientDeps {
  readonly config: LiveModelConfig;
  /** Required when `config.auth` is `entra`. */
  readonly credential?: ModelCredential | undefined;
  readonly fetch?: typeof fetch;
}

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_TOOL_CALLS_PER_RESPONSE = 8;
export const MAX_TOOL_CALL_ID_CHARS = 128;
export const MAX_TOOL_NAME_CHARS = 64;
export const MAX_TOOL_ARGUMENT_CHARS = 8 * 1024;
export const MAX_RETRY_AFTER_MS = 10_000;

const PER_MESSAGE_OVERHEAD_TOKENS = 8;
const FIXED_OVERHEAD_TOKENS = 32;
const MICRO = 1_000_000n;

/** Whole micro-USD, rounded up, for a token count at a price in micro-USD per million tokens. */
function costOf(pricing: LiveModelPricing, promptTokens: number, completionTokens: number): number {
  const numerator =
    BigInt(promptTokens) * BigInt(pricing.inputMicroUsdPerMillionTokens) +
    BigInt(completionTokens) * BigInt(pricing.outputMicroUsdPerMillionTokens);
  return Number((numerator + MICRO - 1n) / MICRO);
}

const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

function messageBytes(message: ModelMessage): number {
  switch (message.role) {
    case 'system':
    case 'user':
      return utf8(message.content);
    case 'assistant':
      return (
        (message.content === null ? 0 : utf8(message.content)) +
        message.toolCalls.reduce((sum, call) => sum + utf8(call.id) + utf8(call.name) + utf8(call.arguments), 0)
      );
    case 'tool':
      return utf8(message.toolCallId) + utf8(message.content);
  }
}

const TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));
const TOOLS_BYTES = utf8(JSON.stringify(TOOLS));

function toWire(message: ModelMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return message.toolCalls.length === 0
        ? { role: 'assistant', content: message.content ?? '' }
        : {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

const invalid = (): ModelFailure => new ModelFailure('model_response_invalid', 'ambiguous', false);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseToolCalls(value: unknown): ModelToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS_PER_RESPONSE) throw invalid();
  return value.map((entry): ModelToolCall => {
    if (!isRecord(entry) || entry.type !== 'function' || !isRecord(entry.function)) throw invalid();
    const { id } = entry;
    const { name, arguments: args } = entry.function;
    if (
      typeof id !== 'string' ||
      id === '' ||
      id.length > MAX_TOOL_CALL_ID_CHARS ||
      typeof name !== 'string' ||
      name === '' ||
      name.length > MAX_TOOL_NAME_CHARS ||
      typeof args !== 'string' ||
      args.length > MAX_TOOL_ARGUMENT_CHARS
    ) {
      throw invalid();
    }
    return { id, name, arguments: args };
  });
}

const FINISH_REASONS: readonly string[] = ['stop', 'tool_calls', 'length', 'content_filter'];

/** Reads one completion from response text. Anything that is not a well-formed completion is `model_response_invalid`. */
export function parseCompletion(text: string): ModelCompletion {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length < 1) throw invalid();
  const choice: unknown = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw invalid();
  const { message } = choice;
  const content = message.content ?? null;
  const refusal = message.refusal ?? null;
  if ((content !== null && typeof content !== 'string') || (refusal !== null && typeof refusal !== 'string')) throw invalid();

  let usage: ModelUsage | null = null;
  if (isRecord(body.usage) && isCount(body.usage.prompt_tokens) && isCount(body.usage.completion_tokens)) {
    usage = { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens };
  }
  const reason = choice.finish_reason;
  return {
    content,
    refusal,
    toolCalls: parseToolCalls(message.tool_calls),
    finishReason: typeof reason === 'string' && FINISH_REASONS.includes(reason) ? (reason as FinishReason) : 'unknown',
    usage,
  };
}

/** `retry-after-ms`, then `retry-after` (seconds or a date), capped so a retry stays inside the run's time budget. */
export function retryAfterMs(headers: Pick<Headers, 'get'>, nowMs: number): number | null {
  const millis = headers.get('retry-after-ms');
  if (millis !== null && /^\d{1,9}$/.test(millis.trim())) return Math.min(Number(millis), MAX_RETRY_AFTER_MS);
  const after = headers.get('retry-after')?.trim();
  if (after === undefined || after === '') return null;
  if (/^\d{1,6}$/.test(after)) return Math.min(Number(after) * 1000, MAX_RETRY_AFTER_MS);
  // Every HTTP-date form starts with a day name; without this check the lenient date parser accepts strings such as "-5".
  if (!/^[A-Za-z]{3,9}[, ]/.test(after)) return null;
  const date = Date.parse(after);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}

export function statusFailure(status: number, retryAfter: number | null): ModelFailure {
  if (status === 401 || status === 403) return new ModelFailure('model_unauthorized', 'failed', false);
  if (status === 429) return new ModelFailure('model_rate_limited', 'failed', true, retryAfter);
  if (status === 408 || status === 504) return new ModelFailure('model_unavailable', 'ambiguous', true, retryAfter);
  if (status >= 500) return new ModelFailure('model_unavailable', 'failed', true, retryAfter);
  return new ModelFailure('model_bad_request', 'failed', false);
}

const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A failure of the transport. Only an error raised before any connection existed is known not to have reached the model. */
export function transportFailure(error: unknown): ModelFailure {
  if (error instanceof ModelFailure) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new ModelFailure('model_timeout', 'ambiguous', true);
  const cause = isRecord(error) ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : '';
  return new ModelFailure('model_connection_failed', NEVER_CONNECTED.has(code) ? 'failed' : 'ambiguous', true);
}

async function readBounded(response: Response): Promise<string> {
  // The runtime types a body's chunks as any; the Fetch standard makes them bytes.
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw invalid();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createModelClient(deps: ModelClientDeps): ModelClient {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const url = `${config.baseUrl}/chat/completions`;
  if (config.auth === 'entra' && deps.credential === undefined) {
    throw new Error('A credential is required when the model endpoint is called with Entra ID.');
  }

  async function authorization(): Promise<string | null> {
    if (config.auth === 'none' || deps.credential === undefined) return null;
    let token: { readonly token: string } | null;
    try {
      token = await deps.credential.getToken(config.tokenScope);
    } catch {
      throw new ModelFailure('model_auth_failed', 'failed', true);
    }
    if (token === null || token.token === '') throw new ModelFailure('model_auth_failed', 'failed', true);
    return `Bearer ${token.token}`;
  }

  return {
    deployment: config.deployment,
    pricing: config.pricing,

    estimate(messages) {
      const bytes = messages.reduce((sum, message) => sum + messageBytes(message), TOOLS_BYTES);
      // A token carries at least one byte, so the byte count bounds the prompt whatever the tokenizer does.
      const prompt = bytes + FIXED_OVERHEAD_TOKENS + messages.length * PER_MESSAGE_OVERHEAD_TOKENS;
      return {
        tokens: prompt + config.maxOutputTokens,
        costMicroUsd: costOf(config.pricing, prompt, config.maxOutputTokens),
      };
    },

    priceOf: (usage) => costOf(config.pricing, usage.promptTokens, usage.completionTokens),

    async complete(messages) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      const credential = await authorization();
      if (credential !== null) headers.authorization = credential;
      const body = JSON.stringify({
        model: config.deployment,
        messages: messages.map(toWire),
        tools: TOOLS,
        max_completion_tokens: config.maxOutputTokens,
      });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          // A redirect is never followed, so the bearer token cannot be replayed to another host.
          redirect: 'manual',
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        throw transportFailure(error);
      }
      if (!response.ok) {
        const wait = retryAfterMs(response.headers, Date.now());
        await response.body?.cancel().catch(() => undefined);
        throw statusFailure(response.status, wait);
      }
      let text: string;
      try {
        text = await readBounded(response);
      } catch (error) {
        throw transportFailure(error);
      }
      return parseCompletion(text);
    },
  };
}
