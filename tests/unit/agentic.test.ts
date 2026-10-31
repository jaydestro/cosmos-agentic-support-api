import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { parse } from 'yaml';
import { run } from '../support/process.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function frontmatter(name: string): Promise<Record<string, unknown>> {
  const source = await readFile(new URL(`../../.github/workflows/${name}.md`, import.meta.url), 'utf8');
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  assert.ok(yaml);
  return record(parse(yaml));
}

for (const name of ['contract-cosmos-review', 'docs-maintainer']) {
  it(`${name} bounds agent, detector and outputs, keeps agent permissions read-only and requires explicit activation`, async () => {
    const config = await frontmatter(name);
    assert.match(String(config['if']), /RESOLVE_REPOSITORY_AUTOMATION_APPROVED/);
    assert.equal(config['timeout-minutes'], 10);
    assert.equal(config['max-turns'], 8);
    assert.equal(config['max-ai-credits'], 2);
    assert.equal(record(record(config['engine'])['harness'])['max-retries'], 0);
    const safe = record(config['safe-outputs']);
    assert.equal(safe['timeout-minutes'], 5);
    const detection = record(safe['threat-detection']);
    assert.equal(detection['enabled'], true);
    assert.equal(detection['max-ai-credits'], 1);
    assert.equal(detection['max-turns'], 4);
    assert.equal(detection['engine-timeout'], '2m');
    assert.equal(detection['retries'], 0);
    for (const kind of ['report-missing-tool', 'report-missing-data']) {
      assert.deepEqual(safe[kind], { max: 1, 'create-issue': false });
    }
    assert.equal(safe['create-issue'], false);
    for (const forbidden of ['merge-pull-request', 'approve-workflow-run', 'submit-pull-request-review']) {
      assert.ok(!(forbidden in safe));
    }
    const lock = record(parse(await readFile(new URL(`../../.github/workflows/${name}.lock.yml`, import.meta.url), 'utf8')));
    const jobs = record(lock['jobs']);
    const permissions = record(record(jobs['agent'])['permissions']);
    assert.ok(Object.values(permissions).every((value) => value === 'read' || value === 'none'));
    assert.equal(record(jobs['safe_outputs'])['timeout-minutes'], 5);
    const stepsInput: unknown = record(jobs['agent'])['steps'];
    assert.ok(Array.isArray(stepsInput));
    const stepValues: unknown[] = stepsInput;
    assert.ok(stepValues.map(record).some((step) => {
      if (step['env'] === undefined) return false;
      const env = record(step['env']);
      return Number(env['GH_AW_MAX_TURNS']) === 8 && Number(env['GH_AW_HARNESS_MAX_RETRIES']) === 0;
    }), 'compiled agent enforces the turn/retry limits');
    assert.doesNotMatch(JSON.stringify(jobs), /AZURE_DEPLOY_CLIENT_ID|AZURE_SUBSCRIPTION_ID/);
  });
}

it('the actual documentation publication guard rejects tracked, committed or untracked non-README paths', async () => {
  const config = await frontmatter('docs-maintainer');
  const stepsInput: unknown = config['post-steps'];
  assert.ok(Array.isArray(stepsInput));
  const stepValues: unknown[] = stepsInput;
  const script = String(record(stepValues[0])['run']);
  const code = /python3 - <<'PY'\n([\s\S]*?)\nPY/.exec(script)?.[1];
  assert.ok(code);
  const prefix = `
import os, subprocess
os.environ["GITHUB_SHA"] = "a" * 40
def paths(command):
    if command[:2] == ["git", "diff"]:
        assert command == ["git", "diff", "--name-only", "-z", "a" * 40]
        return TRACKED
    assert command == ["git", "ls-files", "--others", "--exclude-standard", "-z"]
    return UNTRACKED
subprocess.check_output = paths
`;
  for (const [tracked, untracked, expected] of [
    ['README.md', '', 0],
    ['README.md\u0000src/index.ts', '', 1],
    ['', 'untracked.md', 1],
  ] as const) {
    const setup = `TRACKED = bytes.fromhex("${Buffer.from(tracked).toString('hex')}")\nUNTRACKED = bytes.fromhex("${Buffer.from(untracked).toString('hex')}")\n`;
    const result = await run(process.platform === 'win32' ? 'python' : 'python3', ['-c', setup + prefix + code]);
    assert.equal(result.code, expected, result.stderr);
  }
});
