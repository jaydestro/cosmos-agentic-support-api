import { ModelFailure, type FinishReason, type ModelClient, type ModelCompletion, type ModelMessage, type ModelSpend, type ModelToolCall, type ModelUsage } from '../../src/agent/model.ts';
import type { LiveModelPricing } from '../../src/config/env.ts';

/** A model double for the runner and the live investigator: it answers from a script and keeps what it was asked. */

export type ScriptReply = ModelCompletion | ModelFailure;
export type ScriptStep = ScriptReply | ((messages: readonly ModelMessage[]) => ScriptReply | Promise<ScriptReply>);

export const TEST_PRICING: LiveModelPricing = {
  inputMicroUsdPerMillionTokens: 2_000_000,
  outputMicroUsdPerMillionTokens: 8_000_000,
  asOf: '2026-01-01',
};

export const DEFAULT_USAGE: ModelUsage = { promptTokens: 400, completionTokens: 60 };
/** What the default pricing charges for `DEFAULT_USAGE`: 400 input tokens at 2 and 60 output tokens at 8 micro-USD each. */
export const DEFAULT_USAGE_COST_MICRO_USD = 400 * 2 + 60 * 8;

export interface ScriptedModelOptions {
  deployment?: string;
  /** What `estimate` returns, whatever the messages; defaults to 1,000 tokens and 10,000 micro-USD. */
  estimate?: ModelSpend;
  pricing?: LiveModelPricing;
}

export interface ScriptedModel extends ModelClient {
  /** The messages of every call, as they stood when the call was made. */
  readonly requests: ModelMessage[][];
  /** How many scripted replies were not used. */
  readonly unused: number;
}

export function scriptedModel(steps: readonly ScriptStep[], options: ScriptedModelOptions = {}): ScriptedModel {
  const pricing = options.pricing ?? TEST_PRICING;
  const spend: ModelSpend = options.estimate ?? { tokens: 1000, costMicroUsd: 10_000 };
  const queue = [...steps];
  const requests: ModelMessage[][] = [];

  return {
    deployment: options.deployment ?? 'test-deployment',
    pricing,
    requests,
    get unused() {
      return queue.length;
    },
    estimate: () => ({ ...spend }),
    priceOf: (usage) =>
      Math.ceil((usage.promptTokens * pricing.inputMicroUsdPerMillionTokens + usage.completionTokens * pricing.outputMicroUsdPerMillionTokens) / 1_000_000),
    async complete(messages) {
      requests.push([...messages]);
      const step = queue.shift();
      if (step === undefined) throw new Error('the scripted model has no reply left');
      const outcome = typeof step === 'function' ? await step(messages) : step;
      if (outcome instanceof ModelFailure) throw outcome;
      return outcome;
    },
  };
}

let nextCallId = 1;

export function toolCall(name: string, args: unknown = {}, id?: string): ModelToolCall {
  const callId = id ?? `call_${String(nextCallId)}`;
  nextCallId += 1;
  return { id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

export interface ReplyOptions {
  content?: string | null;
  refusal?: string | null;
  finishReason?: FinishReason;
  /** `null` is a response that reports no usage. */
  usage?: ModelUsage | null;
}

/** A model message asking for the given tool calls. */
export function asks(calls: readonly ModelToolCall[], options: ReplyOptions = {}): ModelCompletion {
  return {
    content: options.content ?? null,
    refusal: options.refusal ?? null,
    toolCalls: calls,
    finishReason: options.finishReason ?? 'tool_calls',
    usage: options.usage === undefined ? { ...DEFAULT_USAGE } : options.usage,
  };
}

/** A model message that calls no tool. */
export function says(content: string | null, options: ReplyOptions = {}): ModelCompletion {
  return { ...asks([], { finishReason: 'stop', ...options }), content };
}

export const failing = (code: ModelFailure['code'], outcome: ModelFailure['outcome'], retryable: boolean, retryAfterMs: number | null = null): ModelFailure =>
  new ModelFailure(code, outcome, retryable, retryAfterMs);
