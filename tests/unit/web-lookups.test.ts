import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeOutboxError } from '../../src/cases/work.ts';
import { describeStop, NO_DESCRIPTION } from '../../src/domain/stop-reasons.ts';
import { categoryLabel } from '../../web/src/forms.ts';
import {
  describeMode,
  evidenceLabel,
  findingLabel,
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
  workKindLabel,
  workStateLabel,
  workStateTone,
} from '../../web/src/format.ts';
import { session } from '../support/web-fixtures.ts';

/**
 * Codes come from the service and are untrusted. A plain object lookup would answer these names with a function
 * from `Object.prototype` and the page would print its source text or throw, so each label table must answer
 * them exactly as it answers any other code it does not know.
 */
const INHERITED = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
  '__lookupGetter__',
] as const;

const spaced = (code: string): string => code.replaceAll('_', ' ');

describe('label lookups ignore names inherited from Object.prototype', () => {
  for (const name of INHERITED) {
    describe(name, () => {
      it('is an unknown case status', () => {
        assert.deepEqual(statusInfo(name), {
          label: `Unknown status (${name})`,
          tone: 'neutral',
          help: 'This console does not know this status.',
        });
      });

      it('is returned as it is, or with underscores as spaces, by every other label', () => {
        assert.equal(runStateLabel(name), name);
        assert.equal(qualityLabel(name), name);
        assert.equal(evidenceLabel(name), name);
        assert.equal(runModeLabel(name), name);
        assert.equal(usageKindLabel(name), name);
        assert.equal(timelineLabel(name), spaced(name));
        assert.equal(usageOutcomeLabel(name), spaced(name));
        assert.equal(proposalStatusLabel(name), spaced(name));
        assert.equal(findingLabel(name), spaced(name));
        assert.equal(workStateLabel(name), spaced(name));
        assert.equal(workKindLabel(name), spaced(name));
        assert.equal(categoryLabel(name), spaced(name));
      });

      it('has a neutral tone', () => {
        assert.equal(proposalTone(name), 'neutral');
        assert.equal(workStateTone(name), 'neutral');
      });

      it('has no recorded wording for a stop reason or an outbox error', () => {
        assert.equal(describeStop(name), NO_DESCRIPTION);
        assert.equal(describeOutboxError(name), NO_DESCRIPTION);
        assert.equal(stopReasonText(name), `Stopped with code ${name}.`);
      });

      it('is reported as an unknown reason when it is the live-blocked reason', () => {
        const { environment } = session({ environment: { agentMode: 'live', liveAvailable: false, liveBlockedReason: name } });
        const notice = describeMode(environment);
        assert.equal(notice.tone, 'blocked');
        assert.ok(notice.detail.startsWith(`The live model is not available (${name}).`), notice.detail);
      });
    });
  }

  it('still words the codes it does know', () => {
    assert.equal(statusInfo('credited').label, 'Credited (simulated)');
    assert.equal(runStateLabel('budget_exhausted'), 'Stopped: allowance used');
    assert.equal(proposalTone('rejected'), 'bad');
    assert.equal(describeStop('steps_exhausted'), 'The run used its step allowance.');
    assert.equal(stopReasonText('steps_exhausted'), 'The run used its step allowance.');
    assert.equal(stopReasonText(null), null);
  });
});
