import assert from 'node:assert/strict';
import { join } from 'node:path';
import { it } from 'node:test';
import { checkWorkflowPins, validateWorkflowPins } from '../support/workflow-pins.ts';
import { ROOT } from '../support/stack.ts';

const SHA = 'a'.repeat(40);

it('accepts full-SHA action, subdirectory action and reusable-workflow references at job and step level', () => {
  const references = [
    `actions/checkout@${SHA}`,
    `github/gh-aw-actions/setup@${SHA}`,
    `owner/repo/.github/workflows/test.yml@${SHA}`,
  ];
  assert.deepEqual(validateWorkflowPins({
    jobs: {
      check: { steps: references.slice(0, 2).map((uses) => ({ uses })) },
      reusable: { uses: references[2] },
    },
  }), references);
});

for (const [label, ref] of [
  ['mutable tag', 'actions/checkout@v5'],
  ['branch', 'actions/checkout@main'],
  ['short SHA', 'actions/checkout@abcdef1'],
  ['39-character SHA', `actions/checkout@${'a'.repeat(39)}`],
  ['41-character SHA', `actions/checkout@${'a'.repeat(41)}`],
  ['nonhex SHA', `actions/checkout@${'g'.repeat(40)}`],
  ['dynamic external reference', '${{ vars.ACTION_REF }}'],
  ['missing SHA', 'owner/repo/.github/workflows/test.yml'],
  ['invalid type', 42],
] as const) {
  it(`rejects a ${label} without logging the reference value`, () => {
    assert.throws(
      () => validateWorkflowPins({ jobs: { check: { uses: ref } } }),
      /^\s*Error: \$\.jobs\.check\.uses must reference .*full 40-character commit SHA/,
    );
  });
}

it('checks handwritten YAML, both generated locks and agentic frontmatter in the repository', async () => {
  const result = await checkWorkflowPins(join(ROOT, '.github', 'workflows'));
  assert.ok(result.files >= 6, 'both source and generated workflow surfaces are covered');
  assert.ok(result.references.length >= 139, 'all current executable references are checked');
  assert.ok(result.references.every((ref) => /@[0-9a-f]{40}$/.test(ref)));
});
