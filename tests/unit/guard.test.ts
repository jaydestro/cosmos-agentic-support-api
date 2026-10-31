import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adjudicate, MAX_INVOICE_REFS, type Adjudication, type CaseFacts } from '../../src/agent/adjudicate.ts';
import {
  MAX_EXPLANATION_CHARS,
  MAX_NOTE_CHARS,
  composeExplanation,
  guardSubmission,
  submissionFor,
  type GuardCode,
  type GuardResult,
  type Lookup,
  type Retrieved,
  type Submission,
} from '../../src/agent/guard.ts';
import type { CaseCategory, Money } from '../../src/cases/documents.ts';
import type { Invoice } from '../../src/data/documents.ts';
import { formatMinor } from '../../src/domain/money.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import {
  SEEDED_FREE_TEXT,
  WHEN_V1,
  accountOf,
  eur,
  invoicesOf,
  policyAt,
  retrievedFor,
  seededInvoice,
  usd,
} from '../support/seed-evidence.ts';

const A1 = 'acct_aurora_0001';
const DUP_A = 'inv_aurora_0001_a';
const DUP_B = 'inv_aurora_0001_b';
const NOTE_LABEL = 'Investigator note (written by the model, not verified): ';
const CATEGORIES: readonly CaseCategory[] = ['duplicate_charge', 'incorrect_amount', 'service_outage', 'other'];

interface Scenario {
  facts: CaseFacts;
  retrieved: Retrieved;
}

function scenario(
  tenantId: string,
  accountId: string,
  category: CaseCategory,
  invoiceIds: readonly string[],
  requestedCredit: Money | null = null,
  when?: Date,
): Scenario {
  return { facts: { category, invoiceIds, requestedCredit }, retrieved: retrievedFor(tenantId, accountId, invoiceIds, when) };
}

function adjudicated({ facts, retrieved }: Scenario): Adjudication {
  const { account, policy } = retrieved;
  assert.ok(account.status === 'present' && policy.status === 'present', 'the scenario must hold an account and a policy');
  return adjudicate(facts, { account: account.value, invoices: retrieved.invoices, policy: policy.value });
}

const proposal = (s: Scenario): Submission => submissionFor(adjudicated(s));

function guard(s: Scenario, patch: Partial<Submission> = {}, retrieved: Retrieved = s.retrieved): GuardResult {
  return guardSubmission(s.facts, retrieved, { ...proposal(s), ...patch });
}

function refused(result: GuardResult, code: GuardCode): string {
  assert.ok(!result.ok, `expected ${code}, but the submission was accepted`);
  assert.equal(result.code, code, result.message);
  return result.message;
}

function accepted(result: GuardResult): Extract<GuardResult, { ok: true }> {
  assert.ok(result.ok, result.ok ? '' : `${result.code}: ${result.message}`);
  return result;
}

const present = <T>(value: T): Lookup<T> => ({ status: 'present', value });

/** Two invoices for one period; either of them may be the one a representative calls the duplicate. */
const duplicate = (requested: Money | null = usd(4900)): Scenario => scenario('aurora', A1, 'duplicate_charge', [DUP_A, DUP_B], requested);
/** The cited invoice does not exist, so the evidence is missing. */
const missing = (): Scenario => scenario('aurora', 'acct_aurora_0003', 'service_outage', ['inv_aurora_0003_b'], usd(790));
/** One invoice is void yet collected and the other is paid with only a failed payment. */
const contradictory = (): Scenario =>
  scenario('aurora', 'acct_aurora_0004', 'duplicate_charge', ['inv_aurora_0004_a', 'inv_aurora_0004_b'], usd(4900));
/** The agreed price matches the invoice, so nothing is due. */
const noCredit = (): Scenario => scenario('aurora', 'acct_aurora_0007', 'incorrect_amount', ['inv_aurora_0007_a'], usd(500));
/** One 90000 invoice paid twice; the policy cap sits far below the eligible amount. */
const overCap = (when?: Date): Scenario =>
  scenario('aurora', 'acct_aurora_0005', 'duplicate_charge', ['inv_aurora_0005_a', 'inv_aurora_0005_b'], usd(90000), when);

const LONE_SURROGATE = /\p{Cs}/u;

describe('composeExplanation', () => {
  const facts = ['Policy credit-policy v2, clause dup-charge.', 'Proposed credit: USD 49.00.'];

  it('is the facts alone when there is no note, or the note is blank', () => {
    assert.equal(composeExplanation(facts, null), facts.join(' '));
    assert.equal(composeExplanation(facts, ' \n\t '), facts.join(' '));
  });

  it('puts a trimmed note after the facts under a label that says it is unverified', () => {
    assert.equal(composeExplanation(facts, '  Looks like a double charge.  '), `${facts.join(' ')}\n\n${NOTE_LABEL}Looks like a double charge.`);
  });

  it('leaves the facts whole when they and the note fit', () => {
    const text = composeExplanation(['f'.repeat(900)], 'n'.repeat(900));
    assert.ok(text.startsWith('f'.repeat(900)));
    assert.ok(text.endsWith('n'.repeat(900)));
  });

  it('clips long facts to make room for the whole note', () => {
    const note = 'n'.repeat(MAX_NOTE_CHARS);
    const text = composeExplanation(['f'.repeat(3000)], note);
    assert.equal(text.length, MAX_EXPLANATION_CHARS);
    assert.ok(text.endsWith(`${NOTE_LABEL}${note}`), 'the note must survive intact');
    assert.ok(text.includes('…\n\n'), 'the clipped facts end with an ellipsis');
  });

  it('clips an oversized note and still keeps a share of the facts', () => {
    const text = composeExplanation(['f'.repeat(3000)], 'n'.repeat(5000));
    assert.ok(text.length <= MAX_EXPLANATION_CHARS);
    const noteText = text.slice(text.indexOf(NOTE_LABEL) + NOTE_LABEL.length);
    assert.ok(noteText.length <= MAX_NOTE_CHARS, 'the note is limited on its own');
    assert.ok(noteText.endsWith('…'));
    assert.ok(text.startsWith('f'.repeat(900)), 'a share of the facts always remains');
  });

  it('clips facts alone to the limit', () => {
    const text = composeExplanation(['f'.repeat(3000)], null);
    assert.equal(text.length, MAX_EXPLANATION_CHARS);
    assert.ok(text.endsWith('…'));
  });

  it('never splits a surrogate pair, whichever side the cut falls on', () => {
    for (let shift = 0; shift < 4; shift += 1) {
      const text = composeExplanation(['a'.repeat(shift) + '😀'.repeat(1500)], 'a'.repeat(shift) + '😀'.repeat(800));
      assert.ok(!LONE_SURROGATE.test(text), `a lone surrogate at shift ${String(shift)}`);
      assert.ok(text.length <= MAX_EXPLANATION_CHARS);
    }
  });

  it('never exceeds the stored limit, whatever the lengths', () => {
    for (const factChars of [0, 10, 1900, 1999, 2000, 2001, 5000]) {
      for (const noteChars of [0, 1, 500, 1000, 1001, 4000]) {
        const text = composeExplanation(['f'.repeat(factChars)], noteChars === 0 ? null : 'n'.repeat(noteChars));
        assert.ok(text.length <= MAX_EXPLANATION_CHARS, `${String(factChars)} fact chars and ${String(noteChars)} note chars gave ${String(text.length)}`);
      }
    }
  });
});

describe('submissionFor', () => {
  it('mirrors a credit: the highest amount code accepts, in the account currency, citing the clause', () => {
    const adjudication = adjudicated(duplicate(null));
    assert.ok(adjudication.kind === 'credit');
    const submission = submissionFor(adjudication);
    assert.deepEqual(submission, {
      kind: 'credit',
      amount: { amountMinor: adjudication.maxCreditMinor, currency: 'USD' },
      note: null,
      invoiceRefs: adjudication.invoiceRefs,
      policyRef: { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' },
      findingCode: null,
    });
  });

  it('mirrors a finding: no amount, the finding code, the clause when there is one', () => {
    const adjudication = adjudicated(missing());
    assert.ok(adjudication.kind === 'finding');
    assert.deepEqual(submissionFor(adjudication, 'Checked twice.'), {
      kind: 'finding',
      amount: null,
      note: 'Checked twice.',
      invoiceRefs: adjudication.invoiceRefs,
      policyRef: adjudication.policyRef,
      findingCode: 'missing_evidence',
    });
  });

  it('does not alias the adjudication it was built from', () => {
    const adjudication = adjudicated(duplicate());
    const submission = submissionFor(adjudication);
    assert.notEqual(submission.invoiceRefs, adjudication.invoiceRefs);
    assert.notEqual(submission.policyRef, adjudication.policyRef);
    submission.invoiceRefs.push({ invoiceId: 'inv_other_0001_a', lineIndex: null });
    assert.ok(adjudication.invoiceRefs.every((ref) => ref.invoiceId !== 'inv_other_0001_a'));
  });
});

describe('guardSubmission: what is accepted', () => {
  it('accepts what submissionFor derives for every seeded account, category, citation and request', () => {
    const outcomes = new Map<string, number>();
    for (const seed of SEED_TENANTS) {
      for (const account of seed.accounts) {
        const owned = invoicesOf(seed.tenantId, account.accountId);
        const newest = owned.toSorted((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt)).slice(0, 5);
        const sources: { label: string; ids: string[]; invoices: Invoice[] }[] = [
          { label: 'cited', ids: owned.slice(0, 5).map((invoice) => invoice.invoiceId), invoices: owned.slice(0, 5) },
          { label: 'listed', ids: [], invoices: newest },
        ];
        for (const source of sources) {
          for (const category of CATEGORIES) {
            for (const asked of [null, 1, 10_000_000]) {
              const label = [seed.tenantId, account.accountId, category, source.label, String(asked)].join('/');
              const facts: CaseFacts = {
                category,
                invoiceIds: source.ids,
                requestedCredit: asked === null ? null : { amountMinor: asked, currency: account.currency },
              };
              const retrieved: Retrieved = {
                account: present(account),
                policy: present(policyAt(seed.tenantId)),
                invoices: source.invoices,
                notFound: [],
              };
              const adjudication = adjudicate(facts, { account, invoices: source.invoices, policy: policyAt(seed.tenantId) });
              const result = accepted(guardSubmission(facts, retrieved, submissionFor(adjudication)));

              assert.deepEqual(result.adjudication, adjudication, label);
              assert.equal(result.accepted.kind, adjudication.kind, label);
              assert.equal(result.accepted.evidenceAssessment, adjudication.assessment, label);
              assert.deepEqual(result.accepted.policyRef, adjudication.policyRef, label);
              assert.deepEqual(result.accepted.invoiceRefs, adjudication.invoiceRefs, label);
              assert.equal(result.accepted.explanation, composeExplanation(adjudication.facts, null), label);
              assert.ok(result.accepted.explanation.length <= MAX_EXPLANATION_CHARS, label);
              assert.ok(result.accepted.invoiceRefs.length <= MAX_INVOICE_REFS, label);
              for (const text of SEEDED_FREE_TEXT) assert.ok(!result.accepted.explanation.includes(text), `${label} leaks free text`);
              if (adjudication.kind === 'credit') {
                assert.deepEqual(result.accepted.amount, { amountMinor: adjudication.maxCreditMinor, currency: account.currency }, label);
                assert.equal(result.accepted.findingCode, null, label);
              } else {
                assert.equal(result.accepted.amount, null, label);
                assert.equal(result.accepted.findingCode, adjudication.findingCode, label);
              }
              const key = adjudication.kind === 'credit' ? 'credit' : `finding:${adjudication.findingCode}`;
              outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
            }
          }
        }
      }
    }
    for (const outcome of ['credit', 'finding:missing_evidence', 'finding:contradictory_evidence', 'finding:no_credit_due', 'finding:exceeds_policy_limit']) {
      assert.ok((outcomes.get(outcome) ?? 0) > 0, `the sweep never produced ${outcome}`);
    }
  });

  it('accepts a credit below the most code allows, and stores exactly the submitted amount', () => {
    const result = accepted(guard(duplicate(), { amount: usd(1) }));
    assert.deepEqual(result.accepted.amount, usd(1));
  });

  it('accepts a credit exactly at the policy limit', () => {
    const s = overCap();
    const adjudication = adjudicated(s);
    assert.ok(adjudication.kind === 'credit');
    assert.equal(adjudication.capMinor, 25000);
    assert.equal(adjudication.maxCreditMinor, 25000);
    assert.equal(accepted(guard(s)).accepted.amount?.amountMinor, 25000);
  });

  it('stamps the assessment, policy reference and finding code from code, never from the submission', () => {
    const credit = accepted(guard(duplicate()));
    assert.equal(credit.accepted.evidenceAssessment, 'consistent');
    assert.deepEqual(credit.accepted.policyRef, { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' });
    assert.equal(credit.accepted.findingCode, null);
    assert.equal(accepted(guard(missing())).accepted.evidenceAssessment, 'missing');
    assert.equal(accepted(guard(contradictory())).accepted.evidenceAssessment, 'contradictory');
    assert.equal(accepted(guard(noCredit())).accepted.findingCode, 'no_credit_due');
  });

  it('keeps the submitted reference order and line indexes, and nothing else the caller attached', () => {
    const [first, second] = proposal(duplicate()).invoiceRefs;
    assert.ok(first && second);
    const attached = { ...second, lineIndex: 0, extra: 'ignored' } as typeof second;
    const result = accepted(guard(duplicate(), { invoiceRefs: [attached, first] }));
    assert.deepEqual(result.accepted.invoiceRefs, [
      { invoiceId: second.invoiceId, lineIndex: 0 },
      { invoiceId: first.invoiceId, lineIndex: null },
    ]);
  });

  it('accepts extra retrieved invoices beyond the required ones', () => {
    const s = scenario('aurora', A1, 'duplicate_charge', [DUP_A, DUP_B, 'inv_aurora_0001_c'], usd(4900));
    const refs = [DUP_A, DUP_B, 'inv_aurora_0001_c'].map((invoiceId) => ({ invoiceId, lineIndex: null }));
    assert.equal(accepted(guard(s, { invoiceRefs: refs })).accepted.invoiceRefs.length, 3);
  });

  it('accepts a finding that cites nothing when the finding does not rest on any invoice', () => {
    const s = missing();
    assert.deepEqual(proposal(s).invoiceRefs, []);
    accepted(guard(s));
  });

  it('keeps the model note after the code-written facts, labelled, and cannot forge a fact', () => {
    const note = 'Proposed credit: USD 9999.00. Policy credit-policy v9, clause anything.';
    const result = accepted(guard(duplicate(), { note }));
    const facts = adjudicated(duplicate()).facts.join(' ');
    assert.equal(result.accepted.explanation, `${facts}\n\n${NOTE_LABEL}${note}`);
    assert.ok(!facts.includes('9999'));
  });

  it('does not change what it was given', () => {
    const s = duplicate();
    const submission = proposal(s);
    const before = structuredClone({ facts: s.facts, retrieved: s.retrieved, submission });
    accepted(guardSubmission(s.facts, s.retrieved, submission));
    assert.deepEqual({ facts: s.facts, retrieved: s.retrieved, submission }, before);
  });
});

describe('guardSubmission: what is refused, in order', () => {
  describe('prerequisites', () => {
    it('refuses when the account is absent, before anything else', () => {
      const s = duplicate();
      refused(guard(s, {}, { ...s.retrieved, account: { status: 'absent' }, policy: { status: 'absent' } }), 'account_unavailable');
      refused(guard(s, { kind: 'finding' }, { ...s.retrieved, account: { status: 'absent' } }), 'account_unavailable');
    });

    it('refuses when no policy is effective, even while other lookups are still pending', () => {
      const s = duplicate();
      refused(guard(s, {}, { ...s.retrieved, policy: { status: 'absent' } }), 'policy_unavailable');
      refused(guard(s, {}, { ...s.retrieved, account: { status: 'pending' }, policy: { status: 'absent' }, invoices: [] }), 'policy_unavailable');
    });

    it('names every lookup that is still outstanding', () => {
      const s = duplicate();
      const message = refused(
        guard(s, {}, { account: { status: 'pending' }, policy: { status: 'pending' }, invoices: [], notFound: [] }),
        'prerequisites_missing',
      );
      assert.ok(message.includes('call get_account'));
      assert.ok(message.includes('call get_policy'));
      assert.ok(message.includes(`call get_invoice for ${DUP_A}, ${DUP_B}`));
    });

    it('names only the cited invoices that were not looked up', () => {
      const s = duplicate();
      const onlyA = { ...s.retrieved, invoices: s.retrieved.invoices.filter((invoice) => invoice.invoiceId === DUP_A) };
      const message = refused(guard(s, {}, onlyA), 'prerequisites_missing');
      assert.ok(message.includes(`call get_invoice for ${DUP_B}`));
      assert.ok(!message.includes(DUP_A));
      assert.ok(!message.includes('get_account'));
    });

    it('counts a lookup that found nothing as done, and then judges the missing evidence', () => {
      const s = duplicate();
      const lookedUp: Retrieved = { ...s.retrieved, invoices: s.retrieved.invoices.filter((invoice) => invoice.invoiceId === DUP_A), notFound: [DUP_B] };
      const message = refused(guard(s, {}, lookedUp), 'kind_mismatch');
      assert.ok(message.includes('missing_evidence'));
    });

    it('does not let an invoice of another account stand in for a cited one', () => {
      const s = duplicate();
      const foreign = seededInvoice('aurora', 'inv_aurora_0002_a');
      const stray: Retrieved = { ...s.retrieved, invoices: [...s.retrieved.invoices, foreign] };
      const cited = { ...s, facts: { ...s.facts, invoiceIds: [...s.facts.invoiceIds, foreign.invoiceId] } };
      const message = refused(guardSubmission(cited.facts, stray, proposal(s)), 'prerequisites_missing');
      assert.ok(message.includes(foreign.invoiceId));
    });
  });

  describe('kind', () => {
    it('refuses a finding when the evidence supports a credit, naming the ceiling', () => {
      const message = refused(guard(duplicate(), { kind: 'finding', amount: null, findingCode: 'no_credit_due' }), 'kind_mismatch');
      assert.ok(message.includes('Submit kind credit'));
      assert.ok(message.includes(formatMinor(4900, 'USD')));
    });

    it('refuses a credit when the evidence supports a finding, naming the finding', () => {
      const message = refused(guard(missing(), { kind: 'credit', amount: usd(790), findingCode: null }), 'kind_mismatch');
      assert.ok(message.includes('missing_evidence'));
    });

    it('is checked before anything about the amount, the reference or the invoices', () => {
      refused(guard(duplicate(), { kind: 'finding', amount: usd(99999), findingCode: null, policyRef: null, invoiceRefs: [] }), 'kind_mismatch');
    });
  });

  describe('findings', () => {
    it('refuses another finding code, or none', () => {
      const s = missing();
      assert.ok(refused(guard(s, { findingCode: 'no_credit_due' }), 'finding_code_mismatch').includes('missing_evidence'));
      refused(guard(s, { findingCode: null }), 'finding_code_mismatch');
    });

    it('refuses an amount on a finding, after its code is right', () => {
      const s = missing();
      refused(guard(s, { amount: usd(1) }), 'finding_has_amount');
      refused(guard(s, { amount: usd(1), findingCode: 'no_credit_due' }), 'finding_code_mismatch');
    });
  });

  describe('credits', () => {
    it('refuses a finding code on a credit, even when the amount is also missing', () => {
      refused(guard(duplicate(), { findingCode: 'no_credit_due' }), 'credit_has_finding_code');
      refused(guard(duplicate(), { findingCode: 'no_credit_due', amount: null }), 'credit_has_finding_code');
    });

    it('requires an amount and names the most code accepts', () => {
      assert.ok(refused(guard(duplicate(), { amount: null }), 'amount_required').includes(formatMinor(4900, 'USD')));
    });

    it('requires a positive whole number of minor units', () => {
      for (const amountMinor of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        refused(guard(duplicate(), { amount: usd(amountMinor) }), 'amount_not_positive');
      }
    });

    it('refuses another currency, before comparing any bound', () => {
      assert.ok(refused(guard(duplicate(), { amount: eur(100) }), 'currency_mismatch').includes('USD'));
      refused(guard(duplicate(), { amount: eur(99_999_999) }), 'currency_mismatch');
      refused(guard(duplicate(), { amount: eur(0) }), 'amount_not_positive');
    });

    it('refuses more than was asked, before the evidence and the limit', () => {
      const message = refused(guard(duplicate(usd(4000)), { amount: usd(4001) }), 'exceeds_request');
      assert.ok(message.includes(formatMinor(4000, 'USD')));
      refused(guard(duplicate(usd(4000)), { amount: usd(99_999) }), 'exceeds_request');
    });

    it('refuses more than the retrieved evidence supports when nothing was asked', () => {
      const message = refused(guard(duplicate(null), { amount: usd(4901) }), 'exceeds_evidence');
      assert.ok(message.includes(formatMinor(4900, 'USD')));
    });

    it('refuses more than the policy limit even when the evidence and the request allow it', () => {
      const message = refused(guard(overCap(), { amount: usd(25001) }), 'exceeds_policy_limit');
      assert.ok(message.includes(formatMinor(25000, 'USD')));
    });

    it('applies the policy version that was retrieved, not the newest', () => {
      const s = overCap(WHEN_V1);
      const adjudication = adjudicated(s);
      assert.ok(adjudication.kind === 'credit');
      assert.equal(adjudication.policyRef.version, 1);
      assert.equal(adjudication.capMinor, 10000);
      refused(guard(s, { amount: usd(10001) }), 'exceeds_policy_limit');
      accepted(guard(s, { amount: usd(10000) }));
    });

    it('bounds the amount by the clause rate, not by the invoice total', () => {
      const s = scenario('aurora', 'acct_aurora_0002', 'service_outage', ['inv_aurora_0002_a'], usd(12000));
      const adjudication = adjudicated(s);
      assert.ok(adjudication.kind === 'credit');
      assert.equal(adjudication.eligibleMinor, 1200);
      refused(guard(s, { amount: usd(1201) }), 'exceeds_evidence');
      accepted(guard(s, { amount: usd(1200) }));
    });
  });

  describe('policy reference', () => {
    const expected = { policyId: 'credit-policy', version: 2, clauseId: 'dup-charge' };

    it('refuses a different version, clause or policy, or none, and names the clause to cite', () => {
      for (const policyRef of [{ ...expected, version: 1 }, { ...expected, clauseId: 'outage-sla' }, { ...expected, policyId: 'other-policy' }, null]) {
        const message = refused(guard(duplicate(), { policyRef }), 'policy_ref_mismatch');
        assert.ok(message.includes('credit-policy v2, clause dup-charge'));
      }
    });

    it('refuses any reference when the outcome rests on no clause', () => {
      const aurora = policyAt('aurora');
      const withoutClause = { ...aurora, clauses: aurora.clauses.filter((clause) => clause.appliesTo !== 'other') };
      const retrieved: Retrieved = {
        account: present(accountOf('aurora', A1)),
        policy: present(withoutClause),
        invoices: [],
        notFound: [],
      };
      const facts: CaseFacts = { category: 'other', invoiceIds: [], requestedCredit: null };
      const finding: Submission = { kind: 'finding', amount: null, note: null, invoiceRefs: [], policyRef: null, findingCode: 'no_credit_due' };
      accepted(guardSubmission(facts, retrieved, finding));
      const message = refused(guardSubmission(facts, retrieved, { ...finding, policyRef: expected }), 'policy_ref_mismatch');
      assert.ok(message.includes('no policy clause'));
    });

    it('is checked after the amount bounds', () => {
      refused(guard(duplicate(null), { amount: usd(4901), policyRef: null }), 'exceeds_evidence');
    });
  });

  describe('invoice references', () => {
    it('refuses more than the proposal limit before looking at any of them', () => {
      const many = Array.from({ length: MAX_INVOICE_REFS + 1 }, (_, index) => ({ invoiceId: `inv_none_${String(index).padStart(4, '0')}`, lineIndex: null }));
      refused(guard(duplicate(), { invoiceRefs: many }), 'too_many_invoice_refs');
    });

    it('refuses an invoice no tool returned for this account, naming it', () => {
      const [first] = proposal(duplicate()).invoiceRefs;
      assert.ok(first);
      for (const invoiceId of ['inv_aurora_0002_a', 'inv_invented_0001']) {
        const message = refused(guard(duplicate(), { invoiceRefs: [first, { invoiceId, lineIndex: null }] }), 'invoice_ref_not_retrieved');
        assert.ok(message.includes(invoiceId));
      }
    });

    it('refuses citing one invoice twice', () => {
      const [first] = proposal(duplicate()).invoiceRefs;
      assert.ok(first);
      const message = refused(guard(duplicate(), { invoiceRefs: [first, { ...first, lineIndex: 0 }] }), 'duplicate_invoice_ref');
      assert.ok(message.includes(first.invoiceId));
    });

    it('refuses a line the invoice does not have, and accepts the lines it has', () => {
      const lines = seededInvoice('aurora', DUP_B).lines.length;
      assert.ok(lines >= 1);
      const [first, second] = proposal(duplicate()).invoiceRefs;
      assert.ok(first && second);
      refused(guard(duplicate(), { invoiceRefs: [first, { ...second, lineIndex: lines }] }), 'invalid_line_index');
      accepted(guard(duplicate(), { invoiceRefs: [first, { ...second, lineIndex: lines - 1 }] }));
    });

    it('requires a credit to cite every invoice it rests on', () => {
      const adjudication = adjudicated(duplicate());
      assert.ok(adjudication.kind === 'credit');
      assert.deepEqual(adjudication.creditedInvoiceIds, [DUP_B]);
      const onlyOriginal = [{ invoiceId: DUP_A, lineIndex: null }];
      assert.ok(refused(guard(duplicate(), { invoiceRefs: onlyOriginal }), 'invoice_refs_incomplete').includes(DUP_B));
      refused(guard(duplicate(), { invoiceRefs: [] }), 'invoice_refs_incomplete');
    });

    it('requires a contradictory finding to cite every invoice that disagrees', () => {
      const s = contradictory();
      const refs = proposal(s).invoiceRefs;
      assert.deepEqual(refs.map((ref) => ref.invoiceId), ['inv_aurora_0004_a', 'inv_aurora_0004_b']);
      accepted(guard(s));
      assert.ok(refused(guard(s, { invoiceRefs: refs.slice(0, 1) }), 'invoice_refs_incomplete').includes('inv_aurora_0004_b'));
      refused(guard(s, { invoiceRefs: [] }), 'invoice_refs_incomplete');
    });

    it('is checked after the policy reference', () => {
      refused(guard(duplicate(), { policyRef: null, invoiceRefs: [] }), 'policy_ref_mismatch');
    });
  });
});
