import { toAccount, toInvoice, INVOICE_SORT_KEY } from '../data/documents.ts';
import { derivePolicies } from '../domain/policy.ts';
import { decodeCursor, encodeCursor } from '../http/cursor.ts';
import { principalOf } from '../http/pipeline.ts';
import { notFound } from '../http/problem.ts';
import { pathInteger, pathString, queryLimit, queryString, type Handler } from './types.ts';

// Every read below is scoped by the caller's tenant. An id from another tenant is simply absent
// from that partition, so it is indistinguishable from an id that does not exist.

export const getAccount: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const doc = await ctx.services.reference.getAccount(tenantId, pathString(ctx, 'accountId'));
  if (doc === null) throw notFound();
  return { status: 200, body: toAccount(doc) };
};

export const listInvoices: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const accountId = pathString(ctx, 'accountId');
  const after = decodeCursor(queryString(ctx, 'continuationToken'), INVOICE_SORT_KEY);
  const { reference } = ctx.services;
  if ((await reference.getAccount(tenantId, accountId)) === null) throw notFound();
  const page = await reference.listInvoices(tenantId, accountId, queryLimit(ctx), after);
  return {
    status: 200,
    body: {
      items: page.items.map(toInvoice),
      continuationToken: page.nextAfter === null ? null : encodeCursor(page.nextAfter),
    },
  };
};

export const getInvoice: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const doc = await ctx.services.reference.getInvoice(tenantId, pathString(ctx, 'invoiceId'));
  if (doc === null) throw notFound();
  return { status: 200, body: toInvoice(doc) };
};

export const listPolicies: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const docs = await ctx.services.reference.listPolicyDocs(tenantId);
  return { status: 200, body: { items: derivePolicies(docs, ctx.now) } };
};

export const getPolicy: Handler = async (ctx) => {
  const { tenantId } = principalOf(ctx);
  const policyId = pathString(ctx, 'policyId');
  const version = pathInteger(ctx, 'policyVersion');
  const docs = await ctx.services.reference.listPolicyVersions(tenantId, policyId);
  const policy = derivePolicies(docs, ctx.now).find((candidate) => candidate.version === version);
  if (policy === undefined) throw notFound();
  return { status: 200, body: policy };
};
