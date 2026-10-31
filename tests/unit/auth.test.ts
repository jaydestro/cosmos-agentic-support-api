import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { hasAnyRole, mapRoles, type Principal } from '../../src/auth/principal.ts';
import { createAuthenticator, extractBearer, REQUIRED_SCOPE } from '../../src/auth/verify.ts';
import type { AuthConfig } from '../../src/config/env.ts';
import { HttpError } from '../../src/http/problem.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { createTestIssuer, type TestIssuer } from '../support/tokens.ts';

const TENANTS = ['aurora', 'borealis'] as const;
const OID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DIRECTORY = '9a1d3e52-7c4b-4f0e-8d6a-2b5c7e9f1a30';
const SCHEME = ['Bear', 'er'].join('');
const authorization = (token: string): string => `${SCHEME} ${token}`;

describe('mapRoles', () => {
  it('maps a single role to its tenant', () => {
    assert.deepEqual(mapRoles(['Resolve.Representative.aurora'], TENANTS), {
      ok: true,
      tenantId: 'aurora',
      roles: ['Representative'],
    });
  });

  it('returns roles in a fixed order and collapses duplicates', () => {
    const result = mapRoles(
      ['Resolve.Operator.borealis', 'Resolve.Representative.borealis', 'Resolve.Operator.borealis', 'Resolve.Approver.borealis'],
      TENANTS,
    );
    assert.deepEqual(result, { ok: true, tenantId: 'borealis', roles: ['Representative', 'Approver', 'Operator'] });
  });

  it('ignores roles that belong to other applications and entries that are not strings', () => {
    const result = mapRoles(['Task.Write', 42, null, { role: 'x' }, 'Resolve.Approver.aurora'], TENANTS);
    assert.deepEqual(result, { ok: true, tenantId: 'aurora', roles: ['Approver'] });
  });

  for (const [name, claim] of [
    ['a missing claim', undefined],
    ['a null claim', null],
    ['a string claim', 'Resolve.Representative.aurora'],
    ['an object claim', { 0: 'Resolve.Representative.aurora' }],
    ['an empty list', []],
    ['only unrelated roles', ['Task.Write', 'Admin']],
  ] as const) {
    it(`reports no role for ${name}`, () => {
      assert.deepEqual(mapRoles(claim, TENANTS), { ok: false, reason: 'no_resolve_role' });
    });
  }

  for (const entry of [
    'resolve.representative.aurora',
    'Resolve.Representative.Aurora',
    'Resolve.Representative.au',
    'Resolve.Representative.1aurora',
    'Resolve.Representative.aurora.extra',
    'Resolve.Representative.aurora\n',
    ' Resolve.Representative.aurora',
    'Resolve.Admin.aurora',
    'Resolve.Representative.',
    'Resolve.Representative',
    `Resolve.Representative.a${'x'.repeat(64)}`,
  ]) {
    it(`does not accept the malformed role ${JSON.stringify(entry)}`, () => {
      assert.deepEqual(mapRoles([entry], TENANTS), { ok: false, reason: 'no_resolve_role' });
    });
  }

  it('refuses a caller with roles in more than one tenant instead of guessing', () => {
    const result = mapRoles(['Resolve.Representative.aurora', 'Resolve.Approver.borealis'], TENANTS);
    assert.deepEqual(result, { ok: false, reason: 'tenant_ambiguous' });
  });

  it('refuses a tenant the application does not know', () => {
    assert.deepEqual(mapRoles(['Resolve.Representative.zephyr'], TENANTS), { ok: false, reason: 'tenant_unknown' });
  });

  it('reports ambiguity before an unknown tenant when both apply', () => {
    assert.deepEqual(mapRoles(['Resolve.Representative.aurora', 'Resolve.Representative.zephyr'], TENANTS), {
      ok: false,
      reason: 'tenant_ambiguous',
    });
  });
});

describe('hasAnyRole', () => {
  const principal: Principal = { principalId: OID, tenantId: 'aurora', roles: ['Representative', 'Approver'] };

  it('is true when at least one allowed role is held', () => {
    assert.equal(hasAnyRole(principal, ['Approver', 'Operator']), true);
  });

  it('is false when none of the allowed roles is held', () => {
    assert.equal(hasAnyRole(principal, ['Operator']), false);
  });

  it('is false for an empty allow list', () => {
    assert.equal(hasAnyRole(principal, []), false);
  });
});

describe('extractBearer', () => {
  const shaped = 'aaaa.bbbb.cccc';

  it('returns the token from a well-formed header', () => {
    assert.equal(extractBearer(authorization(shaped)), shaped);
  });

  it('accepts the scheme in any case and trims surrounding whitespace', () => {
    assert.equal(extractBearer(`  ${SCHEME.toLowerCase()} ${shaped}  `), shaped);
  });

  it('challenges a missing header without an error code', () => {
    assert.throws(
      () => extractBearer(null),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 401);
        assert.equal(error.options.headers?.['WWW-Authenticate'], SCHEME);
        return true;
      },
    );
  });

  for (const [name, header] of [
    ['another scheme', `Basic ${shaped}`],
    ['no token', SCHEME],
    ['an empty token', `${SCHEME} `],
    ['a token with two segments', authorization('aaaa.bbbb')],
    ['a token with four segments', authorization('aaaa.bbbb.cccc.dddd')],
    ['a token with an empty signature', authorization('aaaa.bbbb.')],
    ['a token containing a space', authorization('aaaa.bbbb.cc cc')],
    ['an oversized header', authorization(`${'a'.repeat(8192)}.b.c`)],
  ] as const) {
    it(`rejects ${name} and says the token is invalid`, () => {
      assert.throws(
        () => extractBearer(header),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.status, 401);
          assert.equal(error.code, 'unauthenticated');
          assert.match(error.options.headers?.['WWW-Authenticate'] ?? '', /error="invalid_token"/);
          return true;
        },
      );
    });
  }

  it('uses the documented required scope', () => {
    assert.equal(REQUIRED_SCOPE, 'access_as_user');
  });
});

describe('authenticator', () => {
  function configFor(issuer: TestIssuer, overrides: Partial<AuthConfig> = {}): AuthConfig {
    return {
      mode: 'test-idp',
      issuer: issuer.issuer,
      audiences: [issuer.audience],
      jwksUrl: 'http://127.0.0.1:1/jwks.json',
      directoryId: undefined,
      ...overrides,
    };
  }

  async function setup(overrides: Partial<AuthConfig> = {}) {
    const issuer = await createTestIssuer();
    const { logger, lines } = createMemoryLogger();
    const authenticator = createAuthenticator(configFor(issuer, overrides), TENANTS, { logger, getKey: issuer.getKey() });
    return { issuer, authenticator, lines };
  }

  async function assertRejected(
    attempt: Promise<unknown>,
    status: number,
    code: string,
  ): Promise<void> {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof HttpError, 'expected an HttpError');
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  }

  it('accepts a valid delegated token and lowercases the object id', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({ oid: OID.toUpperCase(), roles: ['Resolve.Representative.aurora'] });
    assert.deepEqual(await authenticator.authenticate(authorization(token)), {
      principalId: OID,
      tenantId: 'aurora',
      roles: ['Representative'],
    });
  });

  it('returns every granted role for the single tenant', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({
      oid: OID,
      roles: ['Resolve.Approver.borealis', 'Resolve.Representative.borealis'],
    });
    const principal = await authenticator.authenticate(authorization(token));
    assert.equal(principal.tenantId, 'borealis');
    assert.deepEqual(principal.roles, ['Representative', 'Approver']);
  });

  it('accepts any of several configured audiences', async () => {
    const issuer = await createTestIssuer();
    const { logger } = createMemoryLogger();
    const authenticator = createAuthenticator(
      configFor(issuer, { audiences: ['api://first', 'api://second'] }),
      TENANTS,
      { logger, getKey: issuer.getKey() },
    );
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], audience: 'api://second' });
    assert.equal((await authenticator.authenticate(authorization(token))).tenantId, 'aurora');
  });

  it('challenges a request that has no Authorization header', async () => {
    const { authenticator } = await setup();
    await assertRejected(authenticator.authenticate(null), 401, 'unauthenticated');
  });

  it('tolerates a small clock skew but not an expired token', async () => {
    const { issuer, authenticator } = await setup();
    const slightlyLate = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], expiresInSeconds: -30 });
    assert.equal((await authenticator.authenticate(authorization(slightlyLate))).tenantId, 'aurora');
    const expired = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], expiresInSeconds: -120 });
    await assertRejected(authenticator.authenticate(authorization(expired)), 401, 'unauthenticated');
  });

  it('rejects the wrong audience', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], audience: 'api://someone-else' });
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects the wrong issuer', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], issuer: 'https://evil.invalid/' });
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects a token signed by a key that is not published', async () => {
    const { issuer, authenticator } = await setup();
    const stranger = await createTestIssuer({ issuer: issuer.issuer, audience: issuer.audience });
    const token = await stranger.mint({ oid: OID, roles: ['Resolve.Operator.aurora'] });
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects a symmetric-key token even when its header names a published key', async () => {
    const { issuer, authenticator } = await setup();
    const token = await new SignJWT({ oid: OID, scp: 'access_as_user', ver: '2.0', roles: ['Resolve.Operator.aurora'] })
      .setProtectedHeader({ alg: 'HS256', kid: issuer.keyId })
      .setIssuer(issuer.issuer)
      .setAudience(issuer.audience)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects an unsigned token that claims the none algorithm', async () => {
    const { issuer, authenticator } = await setup();
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = [
      encode({ alg: 'none', kid: issuer.keyId }),
      encode({ oid: OID, iss: issuer.issuer, aud: issuer.audience, exp: Math.floor(Date.now() / 1000) + 300 }),
      'AAAA',
    ].join('.');
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects something that only looks like a token', async () => {
    const { authenticator } = await setup();
    await assertRejected(authenticator.authenticate(authorization('aaaa.bbbb.cccc')), 401, 'unauthenticated');
  });

  it('rejects a token without a version claim or with the legacy version', async () => {
    const { issuer, authenticator } = await setup();
    for (const ver of [null, '1.0']) {
      const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], ver });
      await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
    }
  });

  it('rejects an application-only token even when it carries Resolve roles', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Approver.aurora'], idtyp: 'app' });
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
  });

  it('rejects a missing or malformed object id', async () => {
    const { issuer, authenticator } = await setup();
    for (const oid of ['', 'not-a-guid', '3f2504e04f8941d39a0c0305e82c3301', `${OID}0`]) {
      const token = await issuer.mint({ oid: oid === '' ? 'x' : oid, roles: ['Resolve.Operator.aurora'] });
      await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
    }
  });

  it('requires the directory when one is configured, ignoring case', async () => {
    const { issuer, authenticator } = await setup({ directoryId: DIRECTORY });
    const roles = ['Resolve.Representative.aurora'];
    const matching = await issuer.mint({ oid: OID, roles, tid: DIRECTORY.toUpperCase() });
    assert.equal((await authenticator.authenticate(authorization(matching))).tenantId, 'aurora');
    const other = await issuer.mint({ oid: OID, roles, tid: '00000000-0000-4000-8000-000000000000' });
    await assertRejected(authenticator.authenticate(authorization(other)), 401, 'unauthenticated');
    const missing = await issuer.mint({ oid: OID, roles });
    await assertRejected(authenticator.authenticate(authorization(missing)), 401, 'unauthenticated');
  });

  it('answers 403 insufficient_scope when the delegated scope is missing or different', async () => {
    const { issuer, authenticator } = await setup();
    for (const scope of [null, '', 'openid profile', 'access_as_user_extra', 'ACCESS_AS_USER']) {
      const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], scope });
      await assertRejected(authenticator.authenticate(authorization(token)), 403, 'insufficient_scope');
    }
  });

  it('accepts the scope among several', async () => {
    const { issuer, authenticator } = await setup();
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], scope: 'openid access_as_user profile' });
    assert.equal((await authenticator.authenticate(authorization(token))).tenantId, 'aurora');
  });

  it('answers 403 forbidden_role when no Resolve role was granted', async () => {
    const { issuer, authenticator } = await setup();
    for (const roles of [undefined, [], ['Task.Write']]) {
      const token = await issuer.mint({ oid: OID, roles });
      await assertRejected(authenticator.authenticate(authorization(token)), 403, 'forbidden_role');
    }
  });

  it('answers 403 forbidden_tenant for roles in several tenants or an unknown tenant', async () => {
    const { issuer, authenticator } = await setup();
    const several = await issuer.mint({ oid: OID, roles: ['Resolve.Representative.aurora', 'Resolve.Representative.borealis'] });
    await assertRejected(authenticator.authenticate(authorization(several)), 403, 'forbidden_tenant');
    const unknown = await issuer.mint({ oid: OID, roles: ['Resolve.Representative.zephyr'] });
    await assertRejected(authenticator.authenticate(authorization(unknown)), 403, 'forbidden_tenant');
  });

  it('does not write the token or its claims into diagnostics', async () => {
    const { issuer, authenticator, lines } = await setup();
    const token = await issuer.mint({ oid: OID, roles: ['Resolve.Operator.aurora'], audience: 'api://someone-else' });
    await assertRejected(authenticator.authenticate(authorization(token)), 401, 'unauthenticated');
    assert.ok(lines.length > 0, 'a rejection should be logged');
    const output = lines.join('\n');
    assert.ok(!output.includes(token), 'the raw token must not be logged');
    assert.ok(!output.includes(token.split('.')[1] ?? 'missing'), 'the token payload must not be logged');
    assert.ok(!output.includes(OID), 'the caller identity must not be logged for a rejected token');
  });
});
