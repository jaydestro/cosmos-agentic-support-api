import type { components } from '../../contracts/client/index.ts';
import { runCli } from '../../tools/demo/cli.ts';
import type { TransportDependencies } from '../../tools/demo/transport.ts';
import { CASE_ID, caseDetail, creditResult, proposal, run, session } from '../support/web-fixtures.ts';

type Schemas = components['schemas'];

export { CASE_ID, DIGEST } from '../support/web-fixtures.ts';
export const NOW = Date.parse('2026-11-02T16:00:00Z');
export const COMMON = ['--base-url', 'https://resolve.test/api', '--scope', 'api://fictional-resolve-app/.default'];
export const KEY = 'fictional-duplicate-key-001';

export function liveProposal(overrides: Partial<Schemas['Proposal']> = {}): Schemas['Proposal'] {
  return proposal({ approvalExpiresAt: '2026-11-05T16:00:00Z', ...overrides });
}

export function liveCase(overrides: Partial<Schemas['CaseDetail']> = {}): Schemas['CaseDetail'] {
  return caseDetail({
    latestRun: run({ mode: 'live', usage: {
      steps: 5, toolCalls: 4, modelCalls: 2, retries: 0, failedCalls: 0, ambiguousCalls: 0,
      inputTokens: null, outputTokens: null, tokenQuality: 'unknown', costMicroUsd: null, costQuality: 'unknown', activeMs: 1000,
    } }),
    latestProposal: { version: 1, kind: 'credit', status: 'pending_approval', amount: { amountMinor: 4900, currency: 'USD' }, approvalExpiresAt: '2026-11-05T16:00:00Z' },
    ...overrides,
  });
}

export function event(seq: number): Schemas['TimelineItem'] {
  return { seq, at: '2026-11-02T16:00:00Z', kind: 'model_called', actor: { type: 'user', id: 'fictional-user-id' }, summary: 'Fictional timeline.' };
}

export function usageEvent(seq: number, overrides: Partial<Schemas['UsageEvent']> = {}): Schemas['UsageEvent'] {
  return {
    eventId: `event-${String(seq)}`, runId: 'run-1', seq, kind: 'model', name: 'fictional-model',
    outcome: 'succeeded', attempt: 1, at: '2026-11-02T16:00:00Z', inputTokens: null, outputTokens: null,
    tokenQuality: 'unknown', costMicroUsd: null, costQuality: 'unknown', latencyMs: 100, errorCode: null, ...overrides,
  };
}

export function decision(outcome: 'approved' | 'rejected'): Schemas['Decision'] {
  return {
    decisionId: 'fictional-decision', caseId: CASE_ID, proposalVersion: 1, policyVersion: 2,
    proposalDigest: liveProposal().digest, outcome, reason: outcome === 'rejected' ? 'Fictional rejection.' : null,
    decidedBy: { type: 'user', id: 'fictional-approver-id' }, decidedAt: '2026-11-02T16:00:00Z',
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface HarnessOptions {
  readonly detail?: Schemas['CaseDetail'];
  readonly session?: Schemas['Session'];
  readonly proposals?: Schemas['Proposal'][];
  readonly route?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  readonly credential?: TransportDependencies['credential'];
  readonly sleep?: (ms: number) => Promise<void>;
}

/** All credential, API and polling fakes live in test support, never in the CLI. */
export function harness(options: HarnessOptions = {}) {
  const requests: Request[] = [];
  const scopes: (string | string[])[] = [];
  const signals: boolean[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let clock = NOW;
  const detail = options.detail ?? liveCase();
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const custom = await options.route?.(request);
    if (custom !== undefined) return custom;
    const path = new URL(request.url).pathname;
    if (path === '/api/session') return json(options.session ?? session({ environment: { agentMode: 'live', liveAvailable: true } }));
    if (path === '/api/cases' && request.method === 'POST') return json({ case: detail, runId: 'run-1', replayed: false }, 202);
    if (path === `/api/cases/${CASE_ID}`) return json(detail);
    if (path === `/api/cases/${CASE_ID}/runs`) return json({ items: detail.latestRun === null ? [] : [detail.latestRun] });
    if (path === `/api/cases/${CASE_ID}/proposals`) return json({ items: options.proposals ?? [liveProposal()] });
    if (path === `/api/cases/${CASE_ID}/proposals/1`) return json(options.proposals?.[0] ?? liveProposal());
    if (path === `/api/cases/${CASE_ID}/timeline`) return json({ items: [event(1)], continuationToken: null });
    if (path === `/api/cases/${CASE_ID}/runs/run-1/usage`) return json({ items: [usageEvent(1)], continuationToken: null });
    if (path === `/api/cases/${CASE_ID}/credit`) return json(creditResult());
    throw new Error(`Unexpected test route: ${request.method} ${path}`);
  };
  const credential: NonNullable<TransportDependencies['credential']> = options.credential ?? {
    getToken: (scope, tokenOptions) => {
      scopes.push(scope);
      signals.push(tokenOptions?.abortSignal !== undefined);
      return Promise.resolve({ token: 'fictional-access-token', expiresOnTimestamp: Date.now() + 60_000 });
    },
  };
  return {
    requests, scopes, signals, output, errors, fetch: fakeFetch, credential,
    run: (args: readonly string[]) => runCli(args, {
      fetch: fakeFetch, credential,
      out: (text) => { output.push(text); }, err: (text) => { errors.push(text); },
      now: () => clock,
      sleep: options.sleep ?? ((ms) => { clock += ms; return Promise.resolve(); }),
    }),
  };
}
