import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_STATUSES,
  CASE_STATUSES,
  MAX_MINOR_UNITS,
  WORK_STATES,
  actorText,
  describeMode,
  evidenceLabel,
  findingLabel,
  formatBasisPoints,
  formatCostMicroUsd,
  formatCount,
  formatDuration,
  formatMoney,
  formatTimestamp,
  parseMajorUnits,
  proposalStatusLabel,
  proposalTone,
  qualityLabel,
  runModeLabel,
  runStateLabel,
  statusInfo,
  stopReasonText,
  timelineLabel,
  usageKindLabel,
  usageOutcomeLabel,
  usageRows,
  workKindLabel,
  workStateLabel,
  workStateTone,
} from '../../web/src/format.ts';
import { describeStop, NO_DESCRIPTION } from '../../src/domain/stop-reasons.ts';
import { documentedTimelineKinds, property, schemaEnum } from '../support/contract-doc.ts';
import { APPROVER_ID, REPRESENTATIVE_ID, limits, session, usage } from '../support/web-fixtures.ts';

const generic = (code: string): string => code.replaceAll('_', ' ');

describe('formatMoney', () => {
  for (const [amountMinor, currency, expected] of [
    [4900, 'USD', 'USD 49.00'],
    [5, 'EUR', 'EUR 0.05'],
    [0, 'USD', 'USD 0.00'],
    [100, 'USD', 'USD 1.00'],
    [1234567, 'EUR', 'EUR 12345.67'],
    [10_000_000, 'USD', 'USD 100000.00'],
  ] as const) {
    it(`formats ${String(amountMinor)} ${currency} minor units as ${expected}`, () => {
      assert.equal(formatMoney({ amountMinor, currency }), expected);
    });
  }
});

describe('parseMajorUnits', () => {
  for (const [text, expected] of [
    ['49', 4900],
    ['49.5', 4950],
    ['49.05', 4905],
    ['0.01', 1],
    ['0.29', 29],
    ['1.15', 115],
    ['19.99', 1999],
    [' 12.30 ', 1230],
    ['100000', 10_000_000],
    ['100000.00', 10_000_000],
  ] as const) {
    it(`reads ${JSON.stringify(text)} as ${String(expected)} minor units`, () => {
      assert.equal(parseMajorUnits(text), expected);
    });
  }

  for (const text of ['', ' ', '0', '0.00', '100000.01', '1000000', '-1', '+5', '1e3', '12.345', '.5', '5.', 'abc', '1,000', '1 2', '１２']) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      assert.equal(parseMajorUnits(text), null);
    });
  }

  it('uses the same ceiling as the contract', () => {
    assert.equal(MAX_MINOR_UNITS, property('Money', 'amountMinor').maximum);
  });

  it('always returns whole minor units', () => {
    for (const text of ['0.07', '0.29', '1.15', '4.35', '8.2', '19.99']) {
      assert.ok(Number.isInteger(parseMajorUnits(text)), text);
    }
  });
});

describe('formatTimestamp', () => {
  it('says "not yet" for a missing time', () => {
    assert.equal(formatTimestamp(null), 'not yet');
  });

  it('prints UTC to the second', () => {
    assert.equal(formatTimestamp('2026-10-29T09:05:07.123Z'), '2026-10-29 09:05:07 UTC');
  });

  it('converts an offset to UTC, including across a date boundary', () => {
    assert.equal(formatTimestamp('2026-10-29T11:05:07+02:00'), '2026-10-29 09:05:07 UTC');
    assert.equal(formatTimestamp('2026-10-29T23:59:59-05:00'), '2026-10-30 04:59:59 UTC');
  });

  it('returns text it cannot read as it is, instead of a wrong date', () => {
    assert.equal(formatTimestamp('not a time'), 'not a time');
  });
});

describe('actorText', () => {
  it('names the agent and the system without an id', () => {
    assert.equal(actorText({ type: 'agent', id: 'demo-investigator' }, APPROVER_ID), 'The agent');
    assert.equal(actorText({ type: 'system', id: 'executor' }, APPROVER_ID), 'The system');
  });

  it('shows the caller as "You"', () => {
    assert.equal(actorText({ type: 'user', id: APPROVER_ID }, APPROVER_ID), 'You');
  });

  it('never calls an agent or the system "You", even when the ids match', () => {
    assert.equal(actorText({ type: 'agent', id: APPROVER_ID }, APPROVER_ID), 'The agent');
    assert.equal(actorText({ type: 'system', id: APPROVER_ID }, APPROVER_ID), 'The system');
  });

  it('labels another person by the first eight characters of the id', () => {
    assert.equal(actorText({ type: 'user', id: REPRESENTATIVE_ID }, APPROVER_ID), 'User a1000000');
    assert.equal(actorText({ type: 'user', id: APPROVER_ID }, REPRESENTATIVE_ID), 'User a2000000');
  });
});

describe('statusInfo', () => {
  for (const [status, label, tone] of [
    ['queued', 'Queued', 'active'],
    ['investigating', 'Investigating', 'active'],
    ['awaiting_approval', 'Awaiting approval', 'waiting'],
    ['finding_reported', 'Finding reported', 'neutral'],
    ['approved', 'Approved', 'active'],
    ['credited', 'Credited (simulated)', 'good'],
    ['rejected', 'Rejected', 'bad'],
    ['expired', 'Approval expired', 'bad'],
    ['needs_attention', 'Needs attention', 'alert'],
  ] as const) {
    it(`describes ${status}`, () => {
      const info = statusInfo(status);
      assert.equal(info.label, label);
      assert.equal(info.tone, tone);
      assert.ok(info.help.length > 20, 'every status explains itself');
    });
  }

  it('lists exactly the statuses of the contract, in its order', () => {
    assert.deepEqual([...CASE_STATUSES], [...schemaEnum('CaseStatus')]);
  });

  it('polls only statuses that move on without anyone acting', () => {
    assert.deepEqual([...ACTIVE_STATUSES], ['queued', 'investigating', 'approved']);
    for (const status of ACTIVE_STATUSES) assert.ok(CASE_STATUSES.includes(status), status);
  });

  it('shows an unknown status as unknown, with the code, instead of hiding it', () => {
    assert.deepEqual(statusInfo('mystery'), {
      label: 'Unknown status (mystery)',
      tone: 'neutral',
      help: 'This console does not know this status.',
    });
  });

  it('says "credited" only for a simulated credit', () => {
    assert.match(statusInfo('credited').label, /simulated/);
    assert.match(statusInfo('credited').help, /No real money moved/);
  });
});

describe('runStateLabel and stopReasonText', () => {
  it('words every run state of the contract', () => {
    for (const state of schemaEnum('RunState')) {
      assert.notEqual(runStateLabel(state), state);
    }
    assert.equal(runStateLabel('budget_exhausted'), 'Stopped: allowance used');
  });

  it('returns an unknown run state as it is', () => {
    assert.equal(runStateLabel('paused'), 'paused');
  });

  it('has no text for a missing stop reason', () => {
    assert.equal(stopReasonText(null), null);
  });

  it('uses the same wording as the operator listing', () => {
    assert.equal(stopReasonText('steps_exhausted'), describeStop('steps_exhausted'));
    assert.equal(stopReasonText('steps_exhausted'), 'The run used its step allowance.');
  });

  it('reports a code it has no wording for, so the reason is never dropped', () => {
    assert.equal(stopReasonText('some_future_code'), 'Stopped with code some_future_code.');
  });
});

describe('timelineLabel', () => {
  const kinds = documentedTimelineKinds();

  it('reads the documented kinds from the contract', () => {
    assert.ok(kinds.length >= 20, `found ${String(kinds.length)} kinds`);
    assert.ok(kinds.includes('case_created'));
    assert.ok(kinds.includes('approval_expired'));
    assert.equal(new Set(kinds).size, kinds.length, 'no duplicates');
  });

  it('has specific wording for every kind the contract documents', () => {
    for (const kind of kinds) {
      assert.notEqual(timelineLabel(kind), generic(kind), `${kind} needs a label`);
    }
  });

  it('never uses one label for two kinds', () => {
    const labels = kinds.map(timelineLabel);
    assert.equal(new Set(labels).size, labels.length);
  });

  for (const [kind, label] of [
    ['case_created', 'Case created'],
    ['proposal_rejected_by_code', 'Proposal refused by code checks'],
    ['credit_executed', 'Simulated credit issued'],
    ['credit_reconciled', 'Credit reconciled with the provider'],
    ['run_budget_exhausted', 'Investigation stopped: allowance used'],
    ['work_poisoned', 'Work moved to poison'],
  ] as const) {
    it(`labels ${kind}`, () => {
      assert.equal(timelineLabel(kind), label);
    });
  }

  it('shows an unknown kind in words, because the set is open', () => {
    assert.equal(timelineLabel('future_kind_x'), 'future kind x');
  });
});

describe('usage wording', () => {
  it('words every quality of the contract and keeps unknown distinct from zero', () => {
    for (const quality of schemaEnum('UsageQuality')) {
      assert.ok(qualityLabel(quality).length > 0);
    }
    assert.equal(qualityLabel('not_applicable'), 'not applicable');
    assert.equal(qualityLabel('unknown'), 'unknown');
  });

  it('never prints a missing count as zero', () => {
    assert.equal(formatCount(null), 'unknown');
    assert.notEqual(formatCount(null), '0');
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(12), '12');
  });

  it('prints costs in USD with six decimals and a missing cost as unknown', () => {
    assert.equal(formatCostMicroUsd(null), 'unknown');
    assert.equal(formatCostMicroUsd(0), 'USD 0.000000');
    assert.equal(formatCostMicroUsd(12_500), 'USD 0.012500');
    assert.equal(formatCostMicroUsd(250_000), 'USD 0.250000');
    assert.equal(formatCostMicroUsd(1_000_000), 'USD 1.000000');
  });

  it('prints durations in seconds', () => {
    assert.equal(formatDuration(0), '0.0 s');
    assert.equal(formatDuration(1200), '1.2 s');
    assert.equal(formatDuration(90_000), '90.0 s');
  });

  it('words every usage outcome of the contract', () => {
    for (const outcome of usageOutcomes()) {
      assert.notEqual(usageOutcomeLabel(outcome), generic(outcome), outcome);
    }
    assert.equal(usageOutcomeLabel('reserved'), 'Reserved, not finished');
    assert.equal(usageOutcomeLabel('ambiguous'), 'Ambiguous, the outcome is not known');
    assert.equal(usageOutcomeLabel('rejected_by_code'), 'Refused by the service\u2019s own checks');
  });

  it('names tool and model calls', () => {
    assert.equal(usageKindLabel('tool'), 'Tool call');
    assert.equal(usageKindLabel('model'), 'Model call');
    assert.equal(usageKindLabel('other'), 'other');
  });

  it('prints basis points as a percentage', () => {
    assert.equal(formatBasisPoints(1000), '10%');
    assert.equal(formatBasisPoints(250), '2.5%');
    assert.equal(formatBasisPoints(0), '0%');
    assert.equal(formatBasisPoints(10_000), '100%');
  });
});

function usageOutcomes(): readonly string[] {
  const outcome = property('UsageEvent', 'outcome').enum;
  if (outcome === undefined) throw new Error('UsageEvent.outcome is not an enum.');
  return outcome;
}

describe('usageRows', () => {
  const measured = usage({
    steps: 2,
    toolCalls: 4,
    modelCalls: 1,
    retries: 1,
    failedCalls: 1,
    ambiguousCalls: 1,
    inputTokens: 1500,
    outputTokens: 300,
    tokenQuality: 'measured',
    costMicroUsd: 12_500,
    costQuality: 'estimated',
    activeMs: 2500,
  });
  const caps = limits({
    steps: 6,
    toolCalls: 9,
    modelCalls: 3,
    tokens: 20_000,
    costMicroUsd: 125_000,
    retriesPerCall: 1,
    retriesPerRun: 2,
    activeMs: 45_000,
  });

  it('shows each count against its limit', () => {
    assert.deepEqual(usageRows(measured, caps), [
      { label: 'Steps', value: '2 of 6', note: null },
      { label: 'Tool calls', value: '4 of 9', note: null },
      { label: 'Model calls', value: '1 of 3', note: null },
      { label: 'Retries', value: '1 of 2', note: null },
      { label: 'Failed calls', value: '1', note: null },
      { label: 'Ambiguous calls', value: '1', note: null },
      { label: 'Tokens', value: '1500 in, 300 out', note: 'measured; limit 20000 in total' },
      { label: 'Model cost', value: 'USD 0.012500', note: 'estimated; limit USD 0.125000' },
      { label: 'Active time', value: '2.5 s', note: 'limit 45.0 s' },
    ]);
  });

  it('shows plain values when the limits are not known', () => {
    assert.deepEqual(usageRows(measured, null), [
      { label: 'Steps', value: '2', note: null },
      { label: 'Tool calls', value: '4', note: null },
      { label: 'Model calls', value: '1', note: null },
      { label: 'Retries', value: '1', note: null },
      { label: 'Failed calls', value: '1', note: null },
      { label: 'Ambiguous calls', value: '1', note: null },
      { label: 'Tokens', value: '1500 in, 300 out', note: 'measured' },
      { label: 'Model cost', value: 'USD 0.012500', note: 'estimated' },
      { label: 'Active time', value: '2.5 s', note: null },
    ]);
  });

  it('reports the demo investigator as not applicable and never as zero', () => {
    const rows = usageRows(usage(), caps);
    assert.equal(rows.find((row) => row.label === 'Tokens')?.value, 'unknown in, unknown out');
    assert.equal(rows.find((row) => row.label === 'Tokens')?.note, 'not applicable; limit 20000 in total');
    assert.equal(rows.find((row) => row.label === 'Model cost')?.value, 'unknown');
    assert.equal(rows.find((row) => row.label === 'Model calls')?.value, '0 of 3');
  });

  it('keeps one known and one unknown token count apart', () => {
    const rows = usageRows(usage({ inputTokens: 100, outputTokens: null, tokenQuality: 'unknown' }), null);
    assert.equal(rows.find((row) => row.label === 'Tokens')?.value, '100 in, unknown out');
  });
});

describe('proposal wording', () => {
  const expected = {
    pending_approval: ['Awaiting a decision', 'waiting'],
    reported: ['Reported', 'neutral'],
    approved: ['Approved', 'active'],
    rejected: ['Rejected', 'bad'],
    expired: ['Approval expired', 'bad'],
    executed: ['Credit issued (simulated)', 'good'],
    superseded: ['Replaced by a later revision', 'neutral'],
  } as const;

  it('covers exactly the proposal statuses of the contract', () => {
    assert.deepEqual(Object.keys(expected).sort(), [...schemaEnum('ProposalStatus')].sort());
  });

  for (const [status, [label, tone]] of Object.entries(expected)) {
    it(`words and tones ${status}`, () => {
      assert.equal(proposalStatusLabel(status), label);
      assert.equal(proposalTone(status), tone);
    });
  }

  it('treats an unknown proposal status as neutral text', () => {
    assert.equal(proposalStatusLabel('on_hold'), 'on hold');
    assert.equal(proposalTone('on_hold'), 'neutral');
  });

  it('words every evidence assessment and finding code of the contract', () => {
    assert.deepEqual(schemaEnum('EvidenceAssessment').map(evidenceLabel), ['Consistent', 'Missing evidence', 'Contradictory evidence']);
    assert.deepEqual(schemaEnum('FindingCode').map(findingLabel), [
      'Missing evidence',
      'Contradictory evidence',
      'No credit is due',
      'Exceeds the policy limit',
    ]);
  });

  it('names both run modes', () => {
    assert.equal(runModeLabel('demo'), 'Deterministic demo agent');
    assert.equal(runModeLabel('live'), 'Live model');
    assert.equal(runModeLabel('hybrid'), 'hybrid');
    assert.deepEqual([...(property('Run', 'mode').enum ?? [])], ['demo', 'live']);
  });
});

describe('operator work wording', () => {
  it('lists exactly the work states of the contract, in the order the operator sees them', () => {
    assert.deepEqual(
      WORK_STATES.map((state) => state.value),
      [...schemaEnum('WorkState')],
    );
  });

  for (const [value, label, tone] of [
    ['waiting', 'Waiting', 'waiting'],
    ['failed', 'Failed', 'bad'],
    ['poison', 'Poison', 'alert'],
    ['recoverable', 'Recoverable', 'alert'],
    ['budget_exhausted', 'Allowance used', 'alert'],
    ['completed', 'Completed', 'good'],
  ] as const) {
    it(`words and tones ${value}`, () => {
      assert.equal(workStateLabel(value), label);
      assert.equal(workStateTone(value), tone);
      const entry = WORK_STATES.find((state) => state.value === value);
      assert.equal(entry?.label, label);
      assert.ok((entry?.help.length ?? 0) > 20, 'each state explains what it holds');
    });
  }

  it('words every work kind of the contract', () => {
    assert.deepEqual(schemaEnum('WorkKind').map(workKindLabel), ['Proposal approval', 'Investigation run', 'Background work']);
  });

  it('falls back to readable text for an unknown state or kind', () => {
    assert.equal(workStateLabel('on_fire'), 'on fire');
    assert.equal(workStateTone('on_fire'), 'neutral');
    assert.equal(workKindLabel('new_kind'), 'new kind');
  });
});

describe('describeMode', () => {
  it('describes the deterministic demo agent and says no model is called', () => {
    assert.deepEqual(describeMode(session().environment), {
      tone: 'demo',
      label: 'Deterministic demo agent',
      detail: 'Investigations use a deterministic, rule-based investigator. No model is called.',
    });
  });

  it('stays demo in demo mode whatever the live flag says', () => {
    const notice = describeMode(session({ environment: { agentMode: 'demo', liveAvailable: true } }).environment);
    assert.equal(notice.tone, 'demo');
  });

  it('describes an available live model and keeps approval with people', () => {
    const notice = describeMode(session({ environment: { agentMode: 'live', liveAvailable: true } }).environment);
    assert.equal(notice.tone, 'live');
    assert.equal(notice.label, 'Live model');
    assert.match(notice.detail, /cannot approve or execute a credit/);
  });

  for (const [code, reason] of [
    ['live_not_approved', 'Live-model runs are not approved on this deployment.'],
    ['live_not_configured', 'No live-model adapter is configured on this deployment.'],
    ['an_unmapped_code', 'The live model is not available (an_unmapped_code).'],
    [null, 'The live model is not available.'],
  ] as const) {
    it(`reports a blocked live mode (${String(code)}) as blocked and never as demo`, () => {
      const notice = describeMode(session({ environment: { agentMode: 'live', liveAvailable: false, liveBlockedReason: code } }).environment);
      assert.equal(notice.tone, 'blocked');
      assert.equal(notice.label, 'Live model blocked');
      assert.equal(
        notice.detail,
        `${reason} The demo agent is not substituted: a new case stops as "needs attention" with a blocked run.`,
      );
    });
  }

  it('words both blocked reasons the server can report', () => {
    for (const code of ['live_not_approved', 'live_not_configured']) {
      assert.notEqual(describeStop(code), NO_DESCRIPTION, code);
    }
  });
});
