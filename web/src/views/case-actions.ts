import type { DecisionAccess, RevisionAccess } from '../case-state.ts';
import { h } from '../dom.ts';
import { buildApprove, buildReject, buildRevision, COMMENT_MAX, REASON_MAX, type Built } from '../forms.ts';
import type { ApproveRequest, Proposal, RejectRequest, RevisionRequest } from '../types.ts';
import { applyFieldErrors, field, formErrorSlot, notice, panel, whileBusy, type ErrorSlot } from './common.ts';

/** The three things a person can do to a case. Each one reports its own outcome and never throws. */
export interface CaseActions {
  approve(version: number, body: ApproveRequest): Promise<void>;
  reject(version: number, body: RejectRequest): Promise<void>;
  revise(body: RevisionRequest): Promise<void>;
}

interface TextFormOptions<T> {
  readonly heading: string | null;
  readonly key: 'comment' | 'reason';
  readonly label: string;
  readonly hint: string;
  readonly submitLabel: string;
  readonly busyLabel: string;
  readonly primary: boolean;
  readonly build: (text: string) => Built<T>;
  readonly send: (value: T) => Promise<void>;
}

function textForm<T>(options: TextFormOptions<T>, announce: (message: string) => void): HTMLElement {
  const input = h('textarea', { name: options.key, rows: 3 });
  const text = field(options.label, input, options.hint);
  const failure = formErrorSlot();
  const submit = h('button', { type: 'submit', class: options.primary ? 'primary' : 'secondary' }, options.submitLabel);
  const slots: Record<string, ErrorSlot> = { [options.key]: text, proposal: failure.slot };

  async function run(): Promise<void> {
    await whileBusy(submit, options.busyLabel, async () => {
      const built = options.build(input.value);
      if (!built.ok) {
        const count = applyFieldErrors(slots, built.errors);
        announce(`${String(count)} ${count === 1 ? 'problem needs' : 'problems need'} fixing.`);
        return;
      }
      applyFieldErrors(slots, {});
      await options.send(built.value);
    });
  }

  return h(
    'form',
    {
      class: 'form decision-form',
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void run();
      },
    },
    options.heading === null ? null : h('h3', null, options.heading),
    text.element,
    failure.element,
    h('div', { class: 'actions' }, submit),
  );
}

/**
 * What the viewer can do about the latest proposal. A decision is bound to the proposal version, its digest and the
 * policy version it cites, so a change after this page loaded is refused by the service instead of being applied.
 */
export function decisionSection(access: DecisionAccess, proposal: Proposal | null, actions: CaseActions, announce: (message: string) => void): HTMLElement | null {
  switch (access.kind) {
    case 'allowed': {
      if (proposal === null) return null;
      const policy = proposal.policyRef === null ? 'none' : String(proposal.policyRef.version);
      return panel(
        'Your decision',
        h(
          'p',
          null,
          `You are an Approver and did not open this case, so you may decide. A decision is bound to proposal version ${String(proposal.version)}, its digest and policy version ${policy}. The service refuses it if any of them has changed, and an approval that is refused is never executed.`,
        ),
        h(
          'div',
          { class: 'decision-forms' },
          textForm(
            {
              heading: 'Approve',
              key: 'comment',
              label: 'Comment (optional)',
              hint: `Up to ${String(COMMENT_MAX)} characters, stored with the decision.`,
              submitLabel: 'Approve proposal',
              busyLabel: 'Approving…',
              primary: true,
              build: (text) => buildApprove(proposal, text),
              send: (body) => actions.approve(proposal.version, body),
            },
            announce,
          ),
          textForm(
            {
              heading: 'Reject',
              key: 'reason',
              label: 'Reason for rejecting',
              hint: `Required, up to ${String(REASON_MAX)} characters, stored with the decision.`,
              submitLabel: 'Reject proposal',
              busyLabel: 'Rejecting…',
              primary: false,
              build: (text) => buildReject(proposal, text),
              send: (body) => actions.reject(proposal.version, body),
            },
            announce,
          ),
        ),
      );
    }
    case 'creator':
      return panel(
        'Your decision',
        notice('info', 'You opened this case, so you cannot approve or reject its proposal. A different Approver has to decide. This separation of duties is enforced by the service.'),
      );
    case 'not-approver':
      return panel('Your decision', notice('info', 'This proposal is waiting for an Approver. Your sign-in does not have the Approver role, so you cannot decide it.'));
    case 'finding':
      return panel('Your decision', notice('info', 'This is a finding, not a credit proposal, so it needs no approval. If you disagree with it, request a revision.'));
    case 'closed':
    case 'none':
      return null;
  }
}

/** A revision starts another run. It is offered only where the service would accept it. */
export function revisionSection(access: RevisionAccess, actions: CaseActions, announce: (message: string) => void): HTMLElement | null {
  switch (access.kind) {
    case 'allowed':
      return panel(
        'Request a revision',
        h(
          'p',
          null,
          `A revision starts another investigation run. Its proposal needs a fresh approval, and an earlier decision does not carry over. This case can be revised ${String(access.remaining)} more ${access.remaining === 1 ? 'time' : 'times'}.`,
        ),
        textForm(
          {
            heading: null,
            key: 'reason',
            label: 'Reason',
            hint: `Required, up to ${String(REASON_MAX)} characters. It is recorded in the case timeline for reviewers. The agent does not read it.`,
            submitLabel: 'Request revision',
            busyLabel: 'Requesting…',
            primary: true,
            build: buildRevision,
            send: (body) => actions.revise(body),
          },
          announce,
        ),
      );
    case 'limit':
      return panel('Request a revision', notice('info', 'This case has used all of its investigation runs, so it cannot be revised again.'));
    case 'not-now':
    case 'no-role':
      return null;
  }
}
