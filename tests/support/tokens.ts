import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK, type JWTVerifyGetKey } from 'jose';
import { randomUUID } from 'node:crypto';

export const TEST_ISSUER = 'https://test-idp.resolve.invalid/';
export const TEST_AUDIENCE = 'api://resolve-sample-test';

/** Everything a test can vary about a token; the defaults describe a valid delegated user token. */
export interface TokenClaims {
  /** Object id of the signed-in user. */
  oid: string;
  roles?: readonly string[] | undefined;
  /** Space-separated delegated scopes. `null` omits the claim. */
  scope?: string | null;
  /** Token version. `null` omits the claim. */
  ver?: string | null;
  idtyp?: string | undefined;
  tid?: string | undefined;
  audience?: string;
  issuer?: string;
  /** Negative values mint an already-expired token. */
  expiresInSeconds?: number;
}

export interface TestIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  jwks(): { keys: JWK[] };
  /** A local key resolver for `createAuthenticator({ getKey })`. */
  getKey(): JWTVerifyGetKey;
  mint(claims: TokenClaims): Promise<string>;
}

export interface TestIssuerOptions {
  issuer?: string;
  audience?: string;
}

export async function createTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
  const issuer = options.issuer ?? TEST_ISSUER;
  const audience = options.audience ?? TEST_AUDIENCE;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keyId = `test-${randomUUID()}`;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: keyId, alg: 'RS256', use: 'sig' };
  const keySet = { keys: [publicJwk] };

  return {
    issuer,
    audience,
    keyId,
    jwks: () => structuredClone(keySet),
    getKey: () => createLocalJWKSet(structuredClone(keySet)),
    mint: (claims) => signToken(privateKey, keyId, issuer, audience, claims),
  };
}

async function signToken(
  key: CryptoKey,
  keyId: string,
  defaultIssuer: string,
  defaultAudience: string,
  claims: TokenClaims,
): Promise<string> {
  const payload: Record<string, unknown> = { oid: claims.oid };
  if (claims.roles !== undefined) payload['roles'] = [...claims.roles];
  if (claims.scope !== null) payload['scp'] = claims.scope ?? 'access_as_user';
  if (claims.ver !== null) payload['ver'] = claims.ver ?? '2.0';
  if (claims.idtyp !== undefined) payload['idtyp'] = claims.idtyp;
  if (claims.tid !== undefined) payload['tid'] = claims.tid;

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(claims.issuer ?? defaultIssuer)
    .setAudience(claims.audience ?? defaultAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expiresInSeconds ?? 300))
    .sign(key);
}
