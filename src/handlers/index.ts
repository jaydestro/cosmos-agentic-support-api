import {
  createCase,
  getCase,
  getCaseTimeline,
  getCreditResult,
  getInvestigationRun,
  getProposal,
  listCases,
  listInvestigationRuns,
  listProposals,
  listRunUsageEvents,
} from './cases.ts';
import { approveProposal, rejectProposal, requestRevision } from './decisions.ts';
import { getAccount, getInvoice, getPolicy, listInvoices, listPolicies } from './evidence.ts';
import { getOperatorWorkItem, listOperatorWork, recoverWorkItem } from './operator.ts';
import { getHealth, getReadiness, getSession } from './system.ts';
import type { Handler } from './types.ts';

/** One handler per contract operation, by operation id. A unit test pins that none is missing. */
export const handlers: Readonly<Record<string, Handler>> = Object.freeze({
  getHealth,
  getReadiness,
  getSession,
  getAccount,
  listInvoices,
  getInvoice,
  listPolicies,
  getPolicy,

  createCase,
  listCases,
  getCase,
  getCaseTimeline,
  listInvestigationRuns,
  getInvestigationRun,
  listRunUsageEvents,
  listProposals,
  getProposal,
  approveProposal,
  rejectProposal,
  requestRevision,
  getCreditResult,

  listOperatorWork,
  getOperatorWorkItem,
  recoverWorkItem,
});