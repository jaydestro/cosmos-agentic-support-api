import type { components } from '../../contracts/generated/openapi.d.ts';

type Schemas = components['schemas'];

export type Money = Schemas['Money'];
export type Session = Schemas['Session'];
export type Role = Schemas['Role'];
export type Problem = Schemas['Problem'];
export type CaseStatus = Schemas['CaseStatus'];
export type CaseCategory = Schemas['CaseCategory'];
export type CaseSummary = Schemas['CaseSummary'];
export type CaseDetail = Schemas['CaseDetail'];
export type CreateCaseRequest = Schemas['CreateCaseRequest'];
export type Run = Schemas['Run'];
export type RunLimits = Schemas['RunLimits'];
export type UsageSummary = Schemas['UsageSummary'];
export type UsageEvent = Schemas['UsageEvent'];
export type TimelineItem = Schemas['TimelineItem'];
export type Proposal = Schemas['Proposal'];
export type CreditResult = Schemas['CreditResult'];
export type Account = Schemas['Account'];
export type Invoice = Schemas['Invoice'];
export type Policy = Schemas['Policy'];
export type WorkItem = Schemas['WorkItem'];
export type WorkState = Schemas['WorkState'];
export type Allowance = Schemas['Allowance'];
export type RecoverRequest = Schemas['RecoverRequest'];
export type ApproveRequest = Schemas['ApproveRequest'];
export type RejectRequest = Schemas['RejectRequest'];
export type RevisionRequest = Schemas['RevisionRequest'];
export type CaseAccepted = Schemas['CaseAccepted'];
export type Decision = Schemas['Decision'];
export type DecisionAccepted = Schemas['DecisionAccepted'];
export type RecoverAccepted = Schemas['RecoverAccepted'];
export type FieldError = Schemas['FieldError'];
export type PolicyClause = Schemas['PolicyClause'];
export type CasePage = Schemas['CasePage'];
export type TimelinePage = Schemas['TimelinePage'];
export type UsageEventPage = Schemas['UsageEventPage'];
export type InvoicePage = Schemas['InvoicePage'];
export type WorkItemPage = Schemas['WorkItemPage'];
export type RunList = Schemas['RunList'];
export type ProposalList = Schemas['ProposalList'];

export type Subscription = Schemas['Subscription'];
export type InvoiceLine = Schemas['InvoiceLine'];
export type Payment = Schemas['Payment'];
export type InvoiceRef = Schemas['InvoiceRef'];
export type PolicyRef = Schemas['PolicyRef'];

export type Actor = Schemas['Actor'];
export type ProposalBrief = Schemas['ProposalBrief'];
export type ProposalStatus = Schemas['ProposalStatus'];
export type WorkKind = Schemas['WorkKind'];

export type Currency = Money['currency'];
