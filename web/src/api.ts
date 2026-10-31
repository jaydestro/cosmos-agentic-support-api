import { createResolveClient, type ResolveClient } from '../../contracts/client/index.ts';
import { ApiError, AuthError, isAbort, isProblem } from './errors.ts';
import type {
  Account,
  ApproveRequest,
  CaseAccepted,
  CaseDetail,
  CasePage,
  CaseStatus,
  CreateCaseRequest,
  Decision,
  DecisionAccepted,
  Invoice,
  InvoicePage,
  Policy,
  Proposal,
  ProposalList,
  RecoverAccepted,
  RecoverRequest,
  RejectRequest,
  RevisionRequest,
  Run,
  RunList,
  Session,
  TimelinePage,
  UsageEventPage,
  WorkItemPage,
  WorkState,
} from './types.ts';

export interface PageOptions {
  readonly limit?: number;
  readonly continuationToken?: string | null;
  readonly signal?: AbortSignal;
}

interface Settled<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Turns a typed client call into its success value or one `ApiError`. Cancellation is passed through untouched
 * so that a view can tell "the user moved on" from "something failed".
 */
async function call<T>(pending: Promise<Settled<T>>): Promise<T> {
  let result: Settled<T>;
  try {
    result = await pending;
  } catch (error) {
    if (isAbort(error) || error instanceof ApiError) throw error;
    if (error instanceof AuthError) throw new ApiError('auth', error.message);
    if (error instanceof TypeError) throw new ApiError('network', 'The service could not be reached.');
    throw new ApiError('unexpected', 'The response could not be read.');
  }
  if (result.data !== undefined) return result.data;
  const status = result.response.status;
  const kind = status === 401 ? 'auth' : 'problem';
  if (isProblem(result.error)) throw new ApiError(kind, result.error.title, status, result.error);
  throw new ApiError(status === 401 ? 'auth' : 'unexpected', `The service answered HTTP ${String(status)}.`, status);
}

function pageQuery(options: PageOptions): { limit?: number; continuationToken?: string } {
  const token = options.continuationToken;
  return {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(token === undefined || token === null ? {} : { continuationToken: token }),
  };
}

export interface ApiOptions {
  /** `https://host/api`. */
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string>;
}

/** One method per operation the console uses. Request and response shapes come from the generated contract types. */
export class Api {
  readonly #client: ResolveClient;

  constructor(options: ApiOptions) {
    this.#client = createResolveClient({ baseUrl: options.baseUrl, getAccessToken: options.getAccessToken });
  }

  getSession(signal?: AbortSignal): Promise<Session> {
    return call(this.#client.GET('/session', { signal }));
  }

  listCases(options: PageOptions & { readonly status?: CaseStatus } = {}): Promise<CasePage> {
    const query = { ...pageQuery(options), ...(options.status === undefined ? {} : { status: options.status }) };
    return call(this.#client.GET('/cases', { params: { query }, signal: options.signal }));
  }

  createCase(request: CreateCaseRequest, idempotencyKey: string, signal?: AbortSignal): Promise<CaseAccepted> {
    return call(this.#client.POST('/cases', { params: { header: { 'Idempotency-Key': idempotencyKey } }, body: request, signal }));
  }

  getCase(caseId: string, signal?: AbortSignal): Promise<CaseDetail> {
    return call(this.#client.GET('/cases/{caseId}', { params: { path: { caseId } }, signal }));
  }

  getCaseTimeline(caseId: string, options: PageOptions = {}): Promise<TimelinePage> {
    return call(this.#client.GET('/cases/{caseId}/timeline', { params: { path: { caseId }, query: pageQuery(options) }, signal: options.signal }));
  }

  listInvestigationRuns(caseId: string, signal?: AbortSignal): Promise<RunList> {
    return call(this.#client.GET('/cases/{caseId}/runs', { params: { path: { caseId } }, signal }));
  }

  listRunUsageEvents(caseId: string, runId: string, options: PageOptions = {}): Promise<UsageEventPage> {
    return call(
      this.#client.GET('/cases/{caseId}/runs/{runId}/usage', {
        params: { path: { caseId, runId }, query: pageQuery(options) },
        signal: options.signal,
      }),
    );
  }

  listProposals(caseId: string, signal?: AbortSignal): Promise<ProposalList> {
    return call(this.#client.GET('/cases/{caseId}/proposals', { params: { path: { caseId } }, signal }));
  }

  getProposal(caseId: string, version: number, signal?: AbortSignal): Promise<Proposal> {
    return call(this.#client.GET('/cases/{caseId}/proposals/{version}', { params: { path: { caseId, version } }, signal }));
  }

  approveProposal(caseId: string, version: number, body: ApproveRequest, signal?: AbortSignal): Promise<DecisionAccepted> {
    return call(this.#client.POST('/cases/{caseId}/proposals/{version}/approve', { params: { path: { caseId, version } }, body, signal }));
  }

  rejectProposal(caseId: string, version: number, body: RejectRequest, signal?: AbortSignal): Promise<Decision> {
    return call(this.#client.POST('/cases/{caseId}/proposals/{version}/reject', { params: { path: { caseId, version } }, body, signal }));
  }

  requestRevision(caseId: string, body: RevisionRequest, signal?: AbortSignal): Promise<Run> {
    return call(this.#client.POST('/cases/{caseId}/revisions', { params: { path: { caseId } }, body, signal }));
  }

  getAccount(accountId: string, signal?: AbortSignal): Promise<Account> {
    return call(this.#client.GET('/accounts/{accountId}', { params: { path: { accountId } }, signal }));
  }

  listInvoices(accountId: string, options: PageOptions = {}): Promise<InvoicePage> {
    return call(this.#client.GET('/accounts/{accountId}/invoices', { params: { path: { accountId }, query: pageQuery(options) }, signal: options.signal }));
  }

  getInvoice(invoiceId: string, signal?: AbortSignal): Promise<Invoice> {
    return call(this.#client.GET('/invoices/{invoiceId}', { params: { path: { invoiceId } }, signal }));
  }

  getPolicy(policyId: string, policyVersion: number, signal?: AbortSignal): Promise<Policy> {
    return call(this.#client.GET('/policies/{policyId}/versions/{policyVersion}', { params: { path: { policyId, policyVersion } }, signal }));
  }

  listOperatorWork(state: WorkState, options: PageOptions = {}): Promise<WorkItemPage> {
    return call(this.#client.GET('/operator/work', { params: { query: { state, ...pageQuery(options) } }, signal: options.signal }));
  }

  recoverWorkItem(workId: string, body: RecoverRequest, signal?: AbortSignal): Promise<RecoverAccepted> {
    return call(this.#client.POST('/operator/work/{workId}/recover', { params: { path: { workId } }, body, signal }));
  }
}
