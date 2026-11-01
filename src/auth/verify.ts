import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from '../config/env.ts';
import { credentialsMissing, forbidden, unauthenticated } from '../http/problem.ts';
import type { Logger } from '../telemetry/log.ts';
import { mapRoles, type Principal } from './principal.ts';

const MAX_AUTHORIZATION_CHARS = 8192;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const REQUIRED_SCOPE = 'access_as_user';

export interface Authenticator {
  /** Validates the bearer token and returns the tenant-mapped principal, or throws an `HttpError`. */
  authenticate(authorization: string | null): Promise<Principal>;
}

export interface AuthenticatorOptions {
  logger: Logger;
  /** Overrides the remote key set (unit tests only). */
  getKey?: JWTVerifyGetKey;
}

export function extractBearer(authorization: string | null): string {
  if (authorization === null) throw credentialsMissing();
  if (authorization.length > MAX_AUTHORIZATION_CHARS) throw unauthenticated();
  const match = BEARER.exec(authorization.trim());
  if (!match) throw unauthenticated();
  return match[1] as string;
}

function claimString(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' ? value : undefined;
}

function principalFrom(payload: JWTPayload, config: AuthConfig, tenants: readonly string[]): Principal {
  if (config.directoryId !== undefined && claimString(payload, 'tid')?.toLowerCase() !== config.directoryId) {
    throw unauthenticated();
  }
  if (claimString(payload, 'ver') !== '2.0') throw unauthenticated();
  // App-only tokens carry roles but no delegated user; they must never act as a representative.
  if (claimString(payload, 'idtyp') === 'app') throw unauthenticated();
  const oid = claimString(payload, 'oid');
  if (oid === undefined || !GUID.test(oid)) throw unauthenticated();

  const scopes = claimString(payload, 'scp')?.split(' ') ?? [];
  if (!scopes.includes(REQUIRED_SCOPE)) throw forbidden('insufficient_scope', 'Required scope is missing');

  const mapping = mapRoles(payload['roles'], tenants);
  if (!mapping.ok) {
    if (mapping.reason === 'no_resolve_role') throw forbidden('forbidden_role', 'No Resolve role was granted');
    throw forbidden('forbidden_tenant', 'The caller does not map to exactly one tenant');
  }
  return { principalId: oid.toLowerCase(), tenantId: mapping.tenantId, roles: mapping.roles };
}

export function createAuthenticator(
  config: AuthConfig,
  tenants: readonly string[],
  options: AuthenticatorOptions,
): Authenticator {
  const getKey =
    options.getKey ??
    createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });

  return {
    async authenticate(authorization) {
      const token = extractBearer(authorization);
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: config.issuer,
          audience: [...config.audiences],
          algorithms: ['RS256'],
          clockTolerance: 60,
          requiredClaims: ['exp', 'iss', 'aud'],
        }));
      } catch (error) {
        options.logger.warn('token rejected', { error });
        throw unauthenticated();
      }
      return principalFrom(payload, config, tenants);
    },
  };
}
