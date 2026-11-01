import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  CONTROL_TOKEN_VARIABLE,
  CONTROL_URL_VARIABLE,
  RestartInProgressError,
  restartHost,
  startControlServer,
  type ControlServer,
  type RestartOptions,
} from '../support/control.ts';

const TOKEN_HEADER = 'x-resolve-control-token';

let open: ControlServer | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

interface Served {
  readonly environment: Record<string, string>;
  readonly url: string;
  readonly token: string;
  restarts(): number;
  /** What each restart was asked to change. */
  received(): readonly (RestartOptions | undefined)[];
}

async function serve(restart: () => Promise<void> = () => Promise.resolve()): Promise<Served> {
  let restarts = 0;
  const received: (RestartOptions | undefined)[] = [];
  open = await startControlServer({
    restartHost: (options) => {
      restarts += 1;
      received.push(options);
      return restart();
    },
  });
  const environment = { ...open.environment };
  return {
    environment,
    url: environment[CONTROL_URL_VARIABLE] ?? '',
    token: environment[CONTROL_TOKEN_VARIABLE] ?? '',
    restarts: () => restarts,
    received: () => received,
  };
}

async function statusOf(url: string, path: string, method: string, token?: string): Promise<number> {
  const response = await fetch(`${url}${path}`, { method, headers: token === undefined ? {} : { [TOKEN_HEADER]: token } });
  await response.arrayBuffer();
  return response.status;
}

async function postBody(served: Served, body: string, token = served.token): Promise<{ status: number; text: string }> {
  const response = await fetch(`${served.url}/restart-host`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe('stack control channel', () => {
  it('listens on the loopback interface and hands out a url and a long random token', async () => {
    const served = await serve();
    assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(served.token.length >= 40);
    const other = await startControlServer({ restartHost: () => Promise.resolve() });
    try {
      assert.notEqual(other.environment[CONTROL_TOKEN_VARIABLE], served.token);
    } finally {
      await other.close();
    }
  });

  it('restarts the host when the caller presents the token', async () => {
    const served = await serve();
    await restartHost(served.environment);
    assert.equal(served.restarts(), 1);
    await restartHost(served.environment);
    assert.equal(served.restarts(), 2);
  });

  it('keeps the host settings unless the caller gives limit overrides', async () => {
    const served = await serve();
    await restartHost(served.environment);
    await restartHost(served.environment, undefined, { settings: { RESOLVE_LIMIT_RUN_STEPS: '3', RESOLVE_LIMIT_RUN_TOOL_CALLS: '12' } });
    await restartHost(served.environment, undefined, { settings: {} });
    assert.deepEqual(served.received(), [{}, { settings: { RESOLVE_LIMIT_RUN_STEPS: '3', RESOLVE_LIMIT_RUN_TOOL_CALLS: '12' } }, { settings: {} }]);
  });

  it('passes an object body without settings on as "no change"', async () => {
    const served = await serve();
    assert.equal((await postBody(served, '{}')).status, 204);
    assert.deepEqual(served.received(), [{}]);
  });

  it('refuses a body that asks for anything but limit overrides, without restarting the host', async () => {
    const served = await serve();
    const refused = [
      'not json',
      '[]',
      'null',
      '"settings"',
      '{"settings": []}',
      '{"settings": null}',
      '{"settings": "RESOLVE_LIMIT_RUN_STEPS=3"}',
      '{"settings": {}, "other": 1}',
      '{"settings": {"AUTH_MODE": "off"}}',
      '{"settings": {"PROVIDER_FAULTS_ENABLED": "true"}}',
      '{"settings": {"RESOLVE_ENV": "local"}}',
      '{"settings": {"resolve_limit_run_steps": "3"}}',
      '{"settings": {"RESOLVE_LIMIT_": "3"}}',
      '{"settings": {"RESOLVE_LIMIT_RUN-STEPS": "3"}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": 3}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": null}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": ""}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": "-1"}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": "1.5"}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": "3; calc"}}',
      '{"settings": {"RESOLVE_LIMIT_RUN_STEPS": "1234567890"}}',
      `{"settings": {${Array.from({ length: 17 }, (_, index) => `"RESOLVE_LIMIT_K${String(index)}": "1"`).join(', ')}}}`,
    ];
    for (const body of refused) {
      const result = await postBody(served, body);
      assert.equal(result.status, 400, `${body} -> ${String(result.status)} ${result.text}`);
    }
    assert.equal(served.restarts(), 0);
  });

  it('accepts as many overrides as it allows and no more', async () => {
    const served = await serve();
    const body = (count: number): string =>
      JSON.stringify({ settings: Object.fromEntries(Array.from({ length: count }, (_, index) => [`RESOLVE_LIMIT_K${String(index)}`, '1'])) });
    assert.equal((await postBody(served, body(16))).status, 204);
    assert.equal((await postBody(served, body(17))).status, 400);
    assert.equal(served.restarts(), 1);
  });

  it('refuses a body that is too large after reading all of it', async () => {
    const served = await serve();
    const result = await postBody(served, JSON.stringify({ settings: { RESOLVE_LIMIT_RUN_STEPS: '3' }, padding: 'x'.repeat(5000) }));
    assert.equal(result.status, 413);
    assert.equal(served.restarts(), 0);
  });

  it('refuses a caller without the token even when it sends a body', async () => {
    const served = await serve();
    assert.equal((await postBody(served, '{"settings": {}}', 'x')).status, 401);
    assert.equal(served.restarts(), 0);
  });

  it('does not answer until the restart has finished', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = await serve(() => gate);
    let settled = false;
    const pending = restartHost(served.environment).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(served.restarts(), 1);
    assert.equal(settled, false, 'the call returned while the host was still restarting');
    release();
    await pending;
    assert.equal(settled, true);
  });

  it('refuses callers without the token, or with a wrong one, without restarting anything', async () => {
    const served = await serve();
    assert.equal(await statusOf(served.url, '/restart-host', 'POST'), 401);
    assert.equal(await statusOf(served.url, '/restart-host', 'POST', 'x'), 401);
    assert.equal(await statusOf(served.url, '/restart-host', 'POST', 'y'.repeat(served.token.length)), 401);
    assert.equal(await statusOf(served.url, '/restart-host', 'POST', `${served.token}x`), 401);
    assert.equal(await statusOf(served.url, '/elsewhere', 'POST'), 401);
    await assert.rejects(restartHost({ ...served.environment, [CONTROL_TOKEN_VARIABLE]: 'z'.repeat(served.token.length) }), /\(401\)/);
    assert.equal(served.restarts(), 0);
  });

  it('knows only one operation and one method', async () => {
    const served = await serve();
    assert.equal(await statusOf(served.url, '/elsewhere', 'POST', served.token), 404);
    assert.equal(await statusOf(served.url, '/restart-host/', 'POST', served.token), 404);
    assert.equal(await statusOf(served.url, '/restart-host', 'GET', served.token), 405);
    assert.equal(await statusOf(served.url, '/restart-host', 'DELETE', served.token), 405);
    assert.equal(served.restarts(), 0);
  });

  it('reports a restart that is already running as a conflict', async () => {
    const served = await serve(() => Promise.reject(new RestartInProgressError()));
    await assert.rejects(restartHost(served.environment), /\(409\).*already in progress/);
  });

  it('reports a failed restart with its reason', async () => {
    const served = await serve(() => Promise.reject(new Error('the host did not come back')));
    await assert.rejects(restartHost(served.environment), /\(500\).*the host did not come back/);
  });

  it('explains how to get a channel when none is configured', async () => {
    await assert.rejects(restartHost({}), /No stack control channel was found/);
    await assert.rejects(restartHost({ [CONTROL_URL_VARIABLE]: 'http://127.0.0.1:1' }), /No stack control channel was found/);
  });

  it('stops answering once closed', async () => {
    const served = await serve();
    await open?.close();
    open = undefined;
    await assert.rejects(restartHost(served.environment, 5000));
    assert.equal(served.restarts(), 0);
  });
});
