import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadContract, type OperationSpec } from '../../src/contract/load.ts';
import {
  ALLOWANCE_FIELDS,
  CATEGORIES,
  COMMENT_MAX,
  CURRENCIES,
  DESCRIPTION_MAX,
  ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  MAX_INVOICES,
  REASON_MAX,
  buildApprove,
  buildCreateCase,
  buildRecover,
  buildReject,
  buildRevision,
  characterCount,
  createCaseFieldOf,
  newIdempotencyKey,
  recoverFieldOf,
  splitFieldErrors,
  type Built,
  type CreateCaseInput,
  type FieldErrors,
} from '../../web/src/forms.ts';
import { parameterSchema, property, schema, schemaEnum } from '../support/contract-doc.ts';
import { DIGEST, proposal } from '../support/web-fixtures.ts';

const contract = loadContract();

function operation(id: string): OperationSpec {
  const found = contract.byId.get(id);
  if (found === undefined) throw new Error(`The contract has no operation ${id}.`);
  return found;
}

const serverAccepts = (id: string, body: unknown): boolean => contract.validateBody(operation(id), body).length === 0;

function valueOf<T>(built: Built<T>): T {
  if (!built.ok) assert.fail(`expected a value, got ${JSON.stringify(built.errors)}`);
  return built.value;
}

function errorsOf<T>(built: Built<T>): FieldErrors {
  if (built.ok) assert.fail('expected the form to be refused');
  return built.errors;
}

/** Astral characters are one code point but two UTF-16 units, so they separate the two ways of counting. */
const astral = (count: number): string => '\u{1F600}'.repeat(count);

const VALID: CreateCaseInput = {
  accountId: 'acct_aurora_0001',
  invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
  category: 'duplicate_charge',
  requestedAmount: '49.00',
  currency: 'USD',
  description: 'Two charges for the same August invoice.',
  idempotencyKey: 'ui-0123456789abcdef01234567',
};

describe('console limits match the contract', () => {
  it('uses the contract id and idempotency key patterns', () => {
    assert.equal(ID_PATTERN.source, schema('Id').pattern);
    assert.equal(IDEMPOTENCY_KEY_PATTERN.source, parameterSchema('IdempotencyKey').pattern);
  });

  it('agrees with the server on which ids and keys are valid', () => {
    for (const probe of ['abc', 'ab', 'a'.repeat(64), 'a'.repeat(65), 'Abc', '1bc', 'a-b_c', 'a b', 'abc\n', '', 'acct_aurora_0001']) {
      assert.equal(ID_PATTERN.test(probe), contract.validateComponent('Id', probe).length === 0, JSON.stringify(probe));
    }
  });

  it('uses the contract length limits', () => {
    assert.equal(MAX_INVOICES, property('CreateCaseRequest', 'invoiceIds').maxItems);
    assert.equal(DESCRIPTION_MAX, property('CreateCaseRequest', 'description').maxLength);
    assert.equal(property('CreateCaseRequest', 'description').minLength, 1);
    assert.equal(COMMENT_MAX, property('ApproveRequest', 'comment').maxLength);
    assert.equal(REASON_MAX, property('RejectRequest', 'reason').maxLength);
    assert.equal(REASON_MAX, property('RevisionRequest', 'reason').maxLength);
    assert.equal(REASON_MAX, property('RecoverRequest', 'reason').maxLength);
  });

  it('offers exactly the categories and currencies of the contract', () => {
    assert.deepEqual(
      CATEGORIES.map((category) => category.value),
      [...schemaEnum('CaseCategory')],
    );
    assert.deepEqual([...CURRENCIES], [...(property('Money', 'currency').enum ?? [])]);
  });

  it('offers exactly the allowance fields of the contract, with its bounds', () => {
    const contractFields = schema('Allowance').properties ?? {};
    assert.deepEqual(ALLOWANCE_FIELDS.map((field) => field.key).sort(), Object.keys(contractFields).sort());
    for (const field of ALLOWANCE_FIELDS) {
      assert.equal(field.min, contractFields[field.key]?.minimum, `${field.key} minimum`);
      assert.equal(field.max, contractFields[field.key]?.maximum, `${field.key} maximum`);
    }
    assert.equal(schema('Allowance').additionalProperties, false);
    assert.equal(schema('Allowance').minProperties, 1);
  });
});

describe('characterCount', () => {
  it('counts Unicode code points, as the contract does', () => {
    assert.equal(characterCount(''), 0);
    assert.equal(characterCount('abc'), 3);
    assert.equal(characterCount('\u{1F600}'), 1);
    assert.equal('\u{1F600}'.length, 2);
    assert.equal(characterCount(astral(2500)), 2500);
    assert.equal(characterCount('e\u0301'), 2);
    assert.equal(characterCount('\ud83d'), 1);
  });
});

describe('newIdempotencyKey', () => {
  it('turns twelve bytes into a prefixed, zero-padded hex key', () => {
    let asked = 0;
    const key = newIdempotencyKey((length) => {
      asked = length;
      return Uint8Array.from({ length }, (_, index) => index);
    });
    assert.equal(asked, 12);
    assert.equal(key, 'ui-000102030405060708090a0b');
  });

  it('produces keys the contract accepts', () => {
    const header = (name: string): string | null => (name.toLowerCase() === 'idempotency-key' ? newIdempotencyKey(randomBytes) : null);
    for (let index = 0; index < 20; index += 1) {
      const key = newIdempotencyKey(randomBytes);
      assert.match(key, IDEMPOTENCY_KEY_PATTERN);
      assert.equal(key.length, 27);
    }
    const checked = contract.validateParams(operation('createCase'), { path: {}, query: new URLSearchParams(), header });
    assert.deepEqual(checked.errors, []);
  });

  it('does not repeat itself', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey(randomBytes)));
    assert.equal(keys.size, 50);
  });
});

describe('buildCreateCase', () => {
  it('builds the request the service expects', () => {
    assert.deepEqual(valueOf(buildCreateCase(VALID)), {
      idempotencyKey: 'ui-0123456789abcdef01234567',
      request: {
        accountId: 'acct_aurora_0001',
        invoiceIds: ['inv_aurora_0001_a', 'inv_aurora_0001_b'],
        category: 'duplicate_charge',
        requestedCredit: { amountMinor: 4900, currency: 'USD' },
        description: 'Two charges for the same August invoice.',
      },
    });
  });

  it('trims what a person typed', () => {
    const built = valueOf(
      buildCreateCase({
        ...VALID,
        accountId: '  acct_aurora_0001 ',
        invoiceIds: [' inv_aurora_0001_a '],
        description: '  A description.  ',
      }),
    );
    assert.equal(built.request.accountId, 'acct_aurora_0001');
    assert.deepEqual(built.request.invoiceIds, ['inv_aurora_0001_a']);
    assert.equal(built.request.description, 'A description.');
  });

  it('leaves out optional fields that were not filled in', () => {
    const { request } = valueOf(buildCreateCase({ ...VALID, invoiceIds: [], requestedAmount: '  ', currency: '' }));
    assert.equal('invoiceIds' in request, false);
    assert.equal('requestedCredit' in request, false);
    assert.deepEqual(Object.keys(request).sort(), ['accountId', 'category', 'description']);
  });

  it('accepts every category and both currencies', () => {
    for (const { value } of CATEGORIES) assert.equal(buildCreateCase({ ...VALID, category: value }).ok, true, value);
    const euro = valueOf(buildCreateCase({ ...VALID, currency: 'EUR', requestedAmount: '12.5' }));
    assert.deepEqual(euro.request.requestedCredit, { amountMinor: 1250, currency: 'EUR' });
  });

  for (const [name, overrides, key, message] of [
    ['an empty account id', { accountId: '' }, 'accountId', 'Enter an account id such as acct_aurora_0001.'],
    ['an upper-case account id', { accountId: 'Acct_Aurora_0001' }, 'accountId', 'Enter an account id such as acct_aurora_0001.'],
    ['an account id with a space', { accountId: 'acct aurora' }, 'accountId', 'Enter an account id such as acct_aurora_0001.'],
    ['too many invoices', { invoiceIds: ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'] }, 'invoiceIds', 'Select at most 5 invoices.'],
    ['a malformed invoice id', { invoiceIds: ['BAD ID'] }, 'invoiceIds', 'The selected invoices are not valid.'],
    ['a repeated invoice id', { invoiceIds: ['inv_one', 'inv_one'] }, 'invoiceIds', 'The selected invoices are not valid.'],
    ['a repeated invoice id after trimming', { invoiceIds: ['inv_one', ' inv_one '] }, 'invoiceIds', 'The selected invoices are not valid.'],
    ['no category', { category: '' }, 'category', 'Choose a category.'],
    ['an unknown category', { category: 'refund' }, 'category', 'Choose a category.'],
    ['a zero amount', { requestedAmount: '0' }, 'requestedAmount', 'Enter an amount from 0.01 to 100000.00, with at most two decimals.'],
    ['a negative amount', { requestedAmount: '-5' }, 'requestedAmount', 'Enter an amount from 0.01 to 100000.00, with at most two decimals.'],
    ['three decimals', { requestedAmount: '12.345' }, 'requestedAmount', 'Enter an amount from 0.01 to 100000.00, with at most two decimals.'],
    ['an amount above the ceiling', { requestedAmount: '100000.01' }, 'requestedAmount', 'Enter an amount from 0.01 to 100000.00, with at most two decimals.'],
    ['an unknown currency', { currency: 'GBP' }, 'currency', 'Choose USD or EUR.'],
    ['no currency for an amount', { currency: '' }, 'currency', 'Choose USD or EUR.'],
    ['no description', { description: '' }, 'description', 'Describe the dispute.'],
    ['a blank description', { description: '   \n ' }, 'description', 'Describe the dispute.'],
    ['a description over the limit', { description: 'x'.repeat(4001) }, 'description', 'Use at most 4000 characters.'],
    ['a short idempotency key', { idempotencyKey: 'short' }, 'idempotencyKey', 'Use 16 to 64 characters from A-Z, a-z, 0-9, dot, underscore, tilde and hyphen.'],
    ['an idempotency key with a bad character', { idempotencyKey: 'ui-0123456789abcdef!!!!' }, 'idempotencyKey', 'Use 16 to 64 characters from A-Z, a-z, 0-9, dot, underscore, tilde and hyphen.'],
    ['an idempotency key over 64 characters', { idempotencyKey: 'k'.repeat(65) }, 'idempotencyKey', 'Use 16 to 64 characters from A-Z, a-z, 0-9, dot, underscore, tilde and hyphen.'],
  ] as const) {
    it(`refuses ${name} and names the field`, () => {
      const errors = errorsOf(buildCreateCase({ ...VALID, ...overrides }));
      assert.deepEqual(errors, { [key]: message });
    });
  }

  it('does not check the currency while the amount itself is unreadable', () => {
    const errors = errorsOf(buildCreateCase({ ...VALID, requestedAmount: 'abc', currency: 'GBP' }));
    assert.deepEqual(Object.keys(errors), ['requestedAmount']);
  });

  it('reports every problem at once so the form can mark every field', () => {
    const errors = errorsOf(
      buildCreateCase({
        accountId: '',
        invoiceIds: ['BAD'],
        category: '',
        requestedAmount: 'x',
        currency: 'USD',
        description: '',
        idempotencyKey: '',
      }),
    );
    assert.deepEqual(Object.keys(errors).sort(), ['accountId', 'category', 'description', 'idempotencyKey', 'invoiceIds', 'requestedAmount']);
  });

  it('accepts five invoices and a description of exactly 4000 characters', () => {
    const five = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
    assert.equal(buildCreateCase({ ...VALID, invoiceIds: five, description: 'x'.repeat(4000) }).ok, true);
  });

  it('counts emoji as one character each, like the service', () => {
    assert.equal(buildCreateCase({ ...VALID, description: astral(4000) }).ok, true);
    assert.deepEqual(errorsOf(buildCreateCase({ ...VALID, description: astral(4001) })), { description: 'Use at most 4000 characters.' });
  });

  it('produces requests the service accepts, and refuses what the service would refuse', () => {
    const accepted = [
      VALID,
      { ...VALID, invoiceIds: [], requestedAmount: '' },
      { ...VALID, invoiceIds: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'], description: 'x'.repeat(4000) },
      { ...VALID, description: astral(4000) },
      { ...VALID, requestedAmount: '100000', currency: 'EUR' },
    ];
    for (const input of accepted) {
      assert.equal(serverAccepts('createCase', valueOf(buildCreateCase(input)).request), true, JSON.stringify(input).slice(0, 80));
    }

    const body = { accountId: 'acct_aurora_0001', category: 'other' };
    for (const [length, ok] of [
      [4000, true],
      [4001, false],
    ] as const) {
      assert.equal(serverAccepts('createCase', { ...body, description: astral(length) }), ok, `${String(length)} emoji`);
      assert.equal(buildCreateCase({ ...VALID, description: astral(length) }).ok, ok, `${String(length)} emoji in the console`);
    }
    for (const [count, ok] of [
      [5, true],
      [6, false],
    ] as const) {
      const invoiceIds = Array.from({ length: count }, (_, index) => `inv_${String(index)}_x`);
      assert.equal(serverAccepts('createCase', { ...body, description: 'd', invoiceIds }), ok, `${String(count)} invoices`);
      assert.equal(buildCreateCase({ ...VALID, invoiceIds }).ok, ok, `${String(count)} invoices in the console`);
    }
  });
});

describe('createCaseFieldOf and splitFieldErrors', () => {
  for (const [pointer, field] of [
    ['/accountId', 'accountId'],
    ['#/accountId', 'accountId'],
    ['/invoiceIds/0', 'invoiceIds'],
    ['/category', 'category'],
    ['/description', 'description'],
    ['/requestedCredit/currency', 'currency'],
    ['/requestedCredit/amountMinor', 'requestedAmount'],
    ['/requestedCredit', 'requestedAmount'],
    ['/somethingElse', null],
    ['/', null],
    ['', null],
  ] as const) {
    it(`maps the pointer ${JSON.stringify(pointer)} to ${String(field)}`, () => {
      assert.equal(createCaseFieldOf(pointer), field);
    });
  }

  const errors = [
    { pointer: '/accountId', code: 'unknown_account', message: 'First message.' },
    { pointer: '/accountId', code: 'other', message: 'Second message.' },
    { pointer: '/requestedCredit/currency', code: 'currency_mismatch', message: 'Currency message.' },
    { pointer: '/somethingElse', code: 'x', message: 'Left over.' },
  ];

  it('keeps the first message per field and returns the rest for a banner', () => {
    const split = splitFieldErrors(errors);
    assert.deepEqual(split.fields, { accountId: 'First message.', currency: 'Currency message.' });
    assert.deepEqual(split.rest, [{ pointer: '/somethingElse', code: 'x', message: 'Left over.' }]);
  });

  it('accepts another mapper', () => {
    const split = splitFieldErrors(
      [
        { pointer: '/allowance/steps', code: 'maximum', message: 'Too many.' },
        { pointer: '/reason', code: 'minLength', message: 'Needs a reason.' },
        { pointer: '/action', code: 'enum', message: 'Not an action.' },
      ],
      recoverFieldOf,
    );
    assert.deepEqual(split.fields, { steps: 'Too many.', reason: 'Needs a reason.' });
    assert.deepEqual(
      split.rest.map((error) => error.pointer),
      ['/action'],
    );
  });

  it('has nothing to split for no errors', () => {
    assert.deepEqual(splitFieldErrors([]), { fields: {}, rest: [] });
  });
});

describe('buildApprove', () => {
  it('binds the decision to the proposal digest and policy version the approver saw', () => {
    assert.deepEqual(valueOf(buildApprove(proposal(), '')), { policyVersion: 2, proposalDigest: DIGEST });
    const other = `sha256:${'cd'.repeat(32)}`;
    const changed = proposal({ digest: other, policyRef: { policyId: 'credit-policy', version: 3, clauseId: 'dup-charge' } });
    assert.deepEqual(valueOf(buildApprove(changed, '')), { policyVersion: 3, proposalDigest: other });
  });

  it('includes a trimmed comment only when there is one', () => {
    assert.deepEqual(valueOf(buildApprove(proposal(), '  Looks right.  ')), { policyVersion: 2, proposalDigest: DIGEST, comment: 'Looks right.' });
    assert.equal('comment' in valueOf(buildApprove(proposal(), '   ')), false);
  });

  it('refuses a proposal that cites no policy', () => {
    assert.deepEqual(errorsOf(buildApprove(proposal({ policyRef: null }), '')), {
      proposal: 'This proposal cites no policy, so it cannot be approved.',
    });
  });

  it('limits the comment to 500 characters, counting emoji once, like the service', () => {
    assert.equal(buildApprove(proposal(), 'x'.repeat(500)).ok, true);
    assert.deepEqual(errorsOf(buildApprove(proposal(), 'x'.repeat(501))), { comment: 'Use at most 500 characters.' });
    assert.equal(buildApprove(proposal(), astral(500)).ok, true);
    assert.equal(buildApprove(proposal(), astral(501)).ok, false);
  });

  it('produces requests the service accepts and refuses at the same limit', () => {
    assert.equal(serverAccepts('approveProposal', valueOf(buildApprove(proposal(), astral(500)))), true);
    assert.equal(serverAccepts('approveProposal', { policyVersion: 2, proposalDigest: DIGEST, comment: astral(501) }), false);
  });
});

describe('buildReject and buildRevision', () => {
  it('builds a rejection bound to the proposal, with a trimmed reason', () => {
    assert.deepEqual(valueOf(buildReject(proposal(), '  The amount is wrong.  ')), {
      policyVersion: 2,
      proposalDigest: DIGEST,
      reason: 'The amount is wrong.',
    });
  });

  it('requires a reason', () => {
    for (const text of ['', '   ', '\n\t']) {
      assert.deepEqual(errorsOf(buildReject(proposal(), text)), { reason: 'A reason is required.' });
      assert.deepEqual(errorsOf(buildRevision(text)), { reason: 'A reason is required.' });
    }
  });

  it('refuses a proposal that cites no policy', () => {
    assert.deepEqual(errorsOf(buildReject(proposal({ policyRef: null }), 'No.')), {
      proposal: 'This proposal cites no policy, so it cannot be rejected.',
    });
  });

  it('builds a revision with a trimmed reason', () => {
    assert.deepEqual(valueOf(buildRevision('  Please recheck August.  ')), { reason: 'Please recheck August.' });
  });

  it('limits a reason to 500 characters, counting emoji once, like the service', () => {
    for (const build of [(text: string) => buildReject(proposal(), text), buildRevision]) {
      assert.equal(build('x'.repeat(500)).ok, true);
      assert.deepEqual(errorsOf(build('x'.repeat(501))), { reason: 'Use at most 500 characters.' });
      assert.equal(build(astral(500)).ok, true);
      assert.equal(build(astral(501)).ok, false);
    }
  });

  it('produces requests the service accepts and refuses at the same limit', () => {
    assert.equal(serverAccepts('rejectProposal', valueOf(buildReject(proposal(), astral(500)))), true);
    assert.equal(serverAccepts('rejectProposal', { policyVersion: 2, proposalDigest: DIGEST, reason: astral(501) }), false);
    assert.equal(serverAccepts('rejectProposal', { policyVersion: 2, proposalDigest: DIGEST, reason: '' }), false);
    assert.equal(serverAccepts('requestRevision', valueOf(buildRevision(astral(500)))), true);
    assert.equal(serverAccepts('requestRevision', { reason: astral(501) }), false);
  });
});

describe('buildRecover', () => {
  const NONE: Readonly<Record<string, string>> = {};

  it('builds a requeue from a reason alone and ignores any allowance text', () => {
    assert.deepEqual(valueOf(buildRecover({ action: 'requeue', reason: '  Provider is back.  ', allowance: NONE })), {
      action: 'requeue',
      reason: 'Provider is back.',
    });
    assert.deepEqual(valueOf(buildRecover({ action: 'requeue', reason: 'r', allowance: { steps: '99', tokens: 'abc' } })), {
      action: 'requeue',
      reason: 'r',
    });
  });

  it('requires a reason for a requeue', () => {
    assert.deepEqual(errorsOf(buildRecover({ action: 'requeue', reason: ' ', allowance: NONE })), { reason: 'A reason is required.' });
  });

  it('builds a resume from the allowances that were filled in', () => {
    const built = valueOf(buildRecover({ action: 'resume', reason: 'More steps.', allowance: { steps: ' 3 ', activeMs: '5000', toolCalls: '', tokens: '  ' } }));
    assert.deepEqual(built, { action: 'resume', reason: 'More steps.', allowance: { steps: 3, activeMs: 5000 } });
  });

  it('accepts each bound exactly and refuses one beyond it', () => {
    for (const field of ALLOWANCE_FIELDS) {
      const range = `Enter a whole number from ${String(field.min)} to ${String(field.max)}, or leave it empty.`;
      for (const value of [field.min, field.max]) {
        const built = valueOf(buildRecover({ action: 'resume', reason: 'r', allowance: { [field.key]: String(value) } }));
        assert.deepEqual(built.allowance, { [field.key]: value }, `${field.key} ${String(value)}`);
      }
      for (const value of [field.min - 1, field.max + 1]) {
        const errors = errorsOf(buildRecover({ action: 'resume', reason: 'r', allowance: { [field.key]: String(value) } }));
        assert.deepEqual(errors, { [field.key]: range }, `${field.key} ${String(value)}`);
      }
    }
  });

  it('refuses text that is not a whole number', () => {
    for (const text of ['abc', '1.5', '-1', '1e3', '1 2', '1000000000', '\uff11']) {
      const errors = errorsOf(buildRecover({ action: 'resume', reason: 'r', allowance: { steps: text } }));
      assert.deepEqual(Object.keys(errors), ['steps'], JSON.stringify(text));
    }
  });

  it('refuses a resume that grants nothing, and says nothing is reset', () => {
    const errors = errorsOf(buildRecover({ action: 'resume', reason: 'r', allowance: { steps: '', toolCalls: ' ' } }));
    assert.deepEqual(errors, { allowance: 'A resume must grant at least one allowance. Nothing is reset and usage history is kept.' });
  });

  it('reports a missing reason together with a missing allowance', () => {
    const errors = errorsOf(buildRecover({ action: 'resume', reason: '', allowance: NONE }));
    assert.deepEqual(Object.keys(errors).sort(), ['allowance', 'reason']);
  });

  it('reports a missing reason together with an invalid allowance, without a second allowance message', () => {
    const errors = errorsOf(buildRecover({ action: 'resume', reason: '', allowance: { steps: '99' } }));
    assert.deepEqual(Object.keys(errors).sort(), ['reason', 'steps']);
  });

  it('reports only the reason when the allowance is fine', () => {
    assert.deepEqual(Object.keys(errorsOf(buildRecover({ action: 'resume', reason: '', allowance: { steps: '2' } }))), ['reason']);
  });

  it('sends nothing when any allowance is invalid, even if another is fine', () => {
    const errors = errorsOf(buildRecover({ action: 'resume', reason: 'r', allowance: { steps: '2', tokens: '0' } }));
    assert.deepEqual(Object.keys(errors), ['tokens']);
  });

  it('agrees with the service about every allowance bound', () => {
    for (const field of ALLOWANCE_FIELDS) {
      for (const value of [field.min - 1, field.min, field.max, field.max + 1]) {
        const body = { action: 'resume', reason: 'r', allowance: { [field.key]: value } };
        const consoleAccepts = buildRecover({ action: 'resume', reason: 'r', allowance: { [field.key]: String(value) } }).ok;
        assert.equal(consoleAccepts, serverAccepts('recoverWorkItem', body), `${field.key} ${String(value)}`);
      }
    }
  });

  it('produces requests the service accepts', () => {
    assert.equal(serverAccepts('recoverWorkItem', valueOf(buildRecover({ action: 'requeue', reason: astral(500), allowance: NONE }))), true);
    assert.equal(serverAccepts('recoverWorkItem', valueOf(buildRecover({ action: 'resume', reason: 'r', allowance: { steps: '1' } }))), true);
    assert.equal(serverAccepts('recoverWorkItem', { action: 'resume', reason: 'r', allowance: {} }), false);
    assert.equal(serverAccepts('recoverWorkItem', { action: 'requeue', reason: astral(501) }), false);
  });
});

describe('recoverFieldOf', () => {
  for (const [pointer, field] of [
    ['/reason', 'reason'],
    ['#/reason', 'reason'],
    ['/allowance/steps', 'steps'],
    ['#/allowance/activeMs', 'activeMs'],
    ['/allowance/costMicroUsd', 'costMicroUsd'],
    ['/allowance/bogus', 'allowance'],
    ['/allowance', 'allowance'],
    ['/action', null],
    ['', null],
  ] as const) {
    it(`maps the pointer ${JSON.stringify(pointer)} to ${String(field)}`, () => {
      assert.equal(recoverFieldOf(pointer), field);
    });
  }
});
