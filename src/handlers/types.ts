import type { HandlerContext } from '../http/pipeline.ts';
import type { HandlerResult } from '../http/pipeline.ts';
import type { Services } from '../services.ts';

export type Ctx = HandlerContext<Services>;
export type Handler = (ctx: Ctx) => Promise<HandlerResult>;

/** Parameters were already validated against the contract; these only narrow the static type. */
export function pathString(ctx: Ctx, name: string): string {
  const value = ctx.path[name];
  if (typeof value !== 'string') throw new Error(`Path parameter ${name} is missing for ${ctx.op.operationId}`);
  return value;
}

export function pathInteger(ctx: Ctx, name: string): number {
  const value = ctx.path[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Path parameter ${name} is not an integer for ${ctx.op.operationId}`);
  }
  return value;
}

export function headerString(ctx: Ctx, name: string): string {
  const value = ctx.headers[name];
  if (typeof value !== 'string') throw new Error(`Header ${name} is missing for ${ctx.op.operationId}`);
  return value;
}

export function queryString(ctx: Ctx, name: string): string | undefined {
  const value = ctx.query[name];
  return typeof value === 'string' ? value : undefined;
}

export function queryLimit(ctx: Ctx): number {
  const value = ctx.query['limit'];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`The limit parameter was not resolved for ${ctx.op.operationId}`);
  }
  return value;
}
