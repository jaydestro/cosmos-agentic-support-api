export type StepKey = 'submitted' | 'investigating' | 'proposal' | 'decision' | 'credit';
export type StepState = 'done' | 'current' | 'upcoming' | 'stopped' | 'skipped';

export interface Step {
  readonly key: StepKey;
  readonly label: string;
  readonly state: StepState;
}

const LABELS: Readonly<Record<StepKey, string>> = {
  submitted: 'Submitted',
  investigating: 'Investigating',
  proposal: 'Proposal',
  decision: 'Decision',
  credit: 'Credit (simulated)',
};

const ORDER: readonly StepKey[] = ['submitted', 'investigating', 'proposal', 'decision', 'credit'];

function steps(states: Readonly<Record<StepKey, StepState>>): Step[] {
  return ORDER.map((key) => ({ key, label: LABELS[key], state: states[key] }));
}

/**
 * Where a case is on the way from submission to a simulated credit. `needs_attention` stops at the step that failed:
 * after an approval that is the credit, otherwise the investigation. An unknown status shows only the submission.
 */
export function progressOf(status: string, latestProposalStatus: string | null): Step[] {
  switch (status) {
    case 'queued':
    case 'investigating':
      return steps({ submitted: 'done', investigating: 'current', proposal: 'upcoming', decision: 'upcoming', credit: 'upcoming' });
    case 'awaiting_approval':
      return steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'current', credit: 'upcoming' });
    case 'finding_reported':
      return steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'skipped', credit: 'skipped' });
    case 'approved':
      return steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'done', credit: 'current' });
    case 'credited':
      return steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'done', credit: 'done' });
    case 'rejected':
    case 'expired':
      return steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'stopped', credit: 'skipped' });
    case 'needs_attention':
      return latestProposalStatus === 'approved'
        ? steps({ submitted: 'done', investigating: 'done', proposal: 'done', decision: 'done', credit: 'stopped' })
        : steps({ submitted: 'done', investigating: 'stopped', proposal: 'upcoming', decision: 'upcoming', credit: 'upcoming' });
    default:
      return steps({ submitted: 'done', investigating: 'upcoming', proposal: 'upcoming', decision: 'upcoming', credit: 'upcoming' });
  }
}

export const STEP_STATE_LABEL: Readonly<Record<StepState, string>> = {
  done: 'done',
  current: 'in progress',
  upcoming: 'not started',
  stopped: 'stopped',
  skipped: 'not needed',
};
