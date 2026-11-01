import { createHash } from 'node:crypto';
import { createResolveClient, type ResolveClient } from '../../contracts/client/index.ts';
import { mintToken } from './idp.ts';
import type { TokenClaims } from './tokens.ts';

export type RoleName = 'Representative' | 'Approver' | 'Operator';

/** A fictional signed-in person. The same label always yields the same object id. */
export interface Identity {
  readonly label: string;
  readonly tenant: string;
  readonly role: RoleName;
  readonly claims: TokenClaims;
}

export function objectIdFor(label: string): string {
  const hex = createHash('sha256').update(`resolve-test-identity\n${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** An identity holding one application role for one tenant. `name` distinguishes several people with the same role. */
export function identity(tenant: string, role: RoleName, name = 'a'): Identity {
  const label = `${tenant}/${role}/${name}`;
  return { label, tenant, role, claims: { oid: objectIdFor(label), roles: [`Resolve.${role}.${tenant}`] } };
}

/** An identity with an arbitrary role claim list. Tests that follow the identity into storage name its tenant; negative tests leave it `none`. */
export function identityWithRoles(label: string, roles: readonly string[], tenant = 'none'): Identity {
  return { label, tenant, role: 'Representative', claims: { oid: objectIdFor(label), roles } };
}

export interface SendOptions {
  /** An identity (a token is minted), a raw token, or nothing for an anonymous call. */
  as?: Identity | string | null;
  /** Claim overrides applied when minting for an identity. */
  claims?: Partial<TokenClaims>;
  /** Serialized as JSON with `Content-Type: application/json` unless `rawBody` is set. */
  body?: unknown;
  rawBody?: string | Uint8Array;
  contentType?: string | null;
  headers?: Readonly<Record<string, string>>;
}

export interface ApiResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed body for JSON responses; `undefined` otherwise. */
  readonly json: unknown;
}

export interface Api {
  readonly baseUrl: string;
  token(who: Identity, claims?: Partial<TokenClaims>): Promise<string>;
  send(method: string, path: string, options?: SendOptions): Promise<ApiResult>;
  get(path: string, options?: SendOptions): Promise<ApiResult>;
  post(path: string, options?: SendOptions): Promise<ApiResult>;
  /** The generated typed client, acting as `who` (or anonymously). */
  client(who: Identity | null): ResolveClient;
}

export interface ApiOptions {
  /** Origin of the Functions host, for example `http://127.0.0.1:7071`. */
  baseUrl: string;
  mintUrl: string;
}

export function createApi(options: ApiOptions): Api {
  const token = (who: Identity, claims?: Partial<TokenClaims>): Promise<string> =>
    mintToken(options.mintUrl, { ...who.claims, ...claims });

  async function send(method: string, path: string, request: SendOptions = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { Accept: 'application/json, application/problem+json', ...request.headers };
    const subject = request.as;
    if (subject !== undefined && subject !== null) {
      const value = typeof subject === 'string' ? subject : await token(subject, request.claims);
      headers['Authorization'] = ['Bear', 'er'].join('') + ` ${value}`;
    }

    let body: string | Uint8Array | undefined;
    if (request.rawBody !== undefined) body = request.rawBody;
    else if (request.body !== undefined) body = JSON.stringify(request.body);
    if (body !== undefined && request.contentType !== null) headers['Content-Type'] = request.contentType ?? 'application/json';

    const response = await fetch(`${options.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const type = response.headers.get('content-type') ?? '';
    let json: unknown;
    if (/json/i.test(type) && text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  return {
    baseUrl: options.baseUrl,
    token,
    send,
    get: (path, request) => send('GET', path, request),
    post: (path, request) => send('POST', path, request),
    client: (who) =>
      createResolveClient({
        baseUrl: `${options.baseUrl}/api`,
        ...(who === null ? {} : { getAccessToken: () => token(who) }),
      }),
  };
}
