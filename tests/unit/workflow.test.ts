import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { parse } from 'yaml';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

it('CI uses bounded read-only jobs, pinned actions and the shared local gates without publishing diagnostics', async () => {
  const workflow = record(parse(await readFile(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8')));
  assert.deepEqual(workflow['permissions'], { contents: 'read' });
  const triggers = record(workflow['on']);
  assert.ok('pull_request' in triggers);
  assert.ok(!('pull_request_target' in triggers));
  const job = record(record(workflow['jobs'])['check']);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 30);
  const stepsInput: unknown = job['steps'];
  assert.ok(Array.isArray(stepsInput));
  const stepValues: unknown[] = stepsInput;
  const steps = stepValues.map(record);
  for (const step of steps) {
    if ('uses' in step) assert.match(String(step['uses']), /^[\w/-]+@[0-9a-f]{40}$/);
    assert.ok(!String(step['uses']).startsWith('actions/upload-artifact'), 'test diagnostics remain local to the job');
  }
  const commands = steps.filter((step) => 'run' in step).map((step) => String(step['run']));
  for (const command of ['npm run check', 'npm run scan:secrets', 'npm run test:safety', 'npm run test:service']) {
    assert.ok(commands.includes(command), `CI executes ${command}`);
  }
  assert.equal(steps.find((step) => String(step['uses']).startsWith('actions/checkout'))?.['with'] !== undefined, true);
  assert.ok(commands.some((command) => command.includes('sha256sum --check')), 'downloaded host tooling is checksum verified');
  assert.equal(steps.find((step) => step['run'] === 'npm run stack:down')?.['if'], 'always()');
});
