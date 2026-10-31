import { CASE_LIMITS } from '../../../src/config/limits.ts';
import { button, h, replaceContent, type Child } from '../dom.ts';
import { ApiError, isAbort } from '../errors.ts';
import { usageRows, WORK_STATES, workKindLabel, workStateLabel, workStateTone } from '../format.ts';
import { ALLOWANCE_FIELDS, buildRecover, REASON_MAX, recoverFieldOf, splitFieldErrors } from '../forms.ts';
import { caseHash } from '../routes.ts';
import type { RecoverAccepted, RecoverRequest, WorkItem, WorkState } from '../types.ts';
import { applyFieldErrors, badge, definitionList, errorBanner, field, formErrorSlot, labelled, loadingNote, notice, shortCaseId, timeText, uid, whileBusy, type ErrorSlot } from './common.ts';
import { hasRole, type ViewContext } from './context.ts';

const PAGE_SIZES = [5, 10, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_STATE: WorkState = 'failed';

type RecoverAction = WorkItem['actions'][number];

const isWorkState = (value: string): value is WorkState => WORK_STATES.some((known) => known.value === value);

const stateHelp = (state: string): string => WORK_STATES.find((known) => known.value === state)?.help ?? '';

const actionLabel = (action: RecoverAction): string => (action === 'requeue' ? 'Requeue' : 'Resume with an allowance');

const REQUEUE_TEXT = 'Puts the work back in the queue with its attempt count reset. Recorded usage and any credit already issued are kept.';

const RESUME_TEXT = `Gives the run that stopped more allowance. Recorded usage is kept and nothing is reset. A run can be resumed at most ${String(CASE_LIMITS.resumeGrantsPerRun)} times, and the grant must cover the limit that stopped it.`;

function noActionText(item: WorkItem): string {
  if (item.state === 'waiting') return 'Waiting for a human decision. Operators cannot decide proposals; an approver does.';
  if (item.state === 'completed') return 'This work finished, so there is nothing to recover.';
  return 'No recovery action applies to this item.';
}

function usageDetails(item: WorkItem): HTMLElement | null {
  if (item.usage === null) return null;
  return h(
    'details',
    { class: 'usage-details' },
    h('summary', null, 'Usage recorded so far'),
    definitionList(usageRows(item.usage, null).map((row): readonly [string, string] => [row.label, row.note === null ? row.value : `${row.value} (${row.note})`])),
  );
}

/** What the service accepted. Its `state` is the state the item was in when the request arrived, not the one it moved to. */
function recoveredNotice(item: WorkItem, accepted: RecoverAccepted): HTMLElement {
  const grant = accepted.grantNumber === null ? '' : ` Allowance grant ${String(accepted.grantNumber)} of ${String(CASE_LIMITS.resumeGrantsPerRun)} was recorded.`;
  return notice(
    'success',
    h('p', { class: 'banner-title' }, accepted.action === 'requeue' ? 'Requeue accepted' : 'Resume accepted'),
    h('p', null, `The ${workKindLabel(item.kind).toLowerCase()} for case ${shortCaseId(item.caseId)} was “${workStateLabel(accepted.state)}” when the request was accepted.${grant}`),
    h('p', null, 'Recorded usage and any credit already issued were kept. ', h('a', { href: caseHash(item.caseId) }, 'Open the case'), ' to follow it.'),
  );
}

/**
 * Work that needs an operator: what it is, why it is in its state, and the recovery the service allows. Recovery never
 * approves anything and never resets usage. Only an Operator sees any of it, and the service checks the role again.
 */
export function mountOperator(host: HTMLElement, ctx: ViewContext): void {
  if (!hasRole(ctx.session, 'Operator')) {
    replaceContent(host, h('h1', null, 'Operator recovery'), notice('warning', 'Only operators can inspect and recover work. Your roles do not include Operator.'));
    return;
  }

  // A response that arrives after the state changed belongs to an earlier generation and is dropped.
  let generation = 0;
  let loading = false;
  let recovering = false;
  let shown = 0;
  let token: string | null = null;
  let filter: WorkState = DEFAULT_STATE;
  let pageSize: number = DEFAULT_PAGE_SIZE;
  let cards: HTMLUListElement | null = null;
  let closeOpenForm: (() => void) | null = null;

  const statusRegion = h('div', { class: 'messages', tabindex: -1 });
  const listRegion = h('div', { class: 'list-region' });
  const moreRegion = h('div', { class: 'more-region' });
  const helpId = uid('help');
  const help = h('p', { class: 'hint', id: helpId }, stateHelp(DEFAULT_STATE));

  const stateSelect: HTMLSelectElement = h(
    'select',
    {
      'aria-describedby': helpId,
      onchange: () => {
        if (!isWorkState(stateSelect.value)) return;
        filter = stateSelect.value;
        help.textContent = stateHelp(filter);
        replaceContent(statusRegion);
        void load(true);
      },
    },
    WORK_STATES.map((known) => h('option', { value: known.value, selected: known.value === DEFAULT_STATE }, known.label)),
  );
  const sizeSelect: HTMLSelectElement = h(
    'select',
    {
      onchange: () => {
        pageSize = Number(sizeSelect.value);
        void load(true);
      },
    },
    PAGE_SIZES.map((size) => h('option', { value: String(size), selected: size === DEFAULT_PAGE_SIZE }, String(size))),
  );

  function showStatus(message: HTMLElement): void {
    replaceContent(statusRegion, message);
    statusRegion.focus();
  }

  async function send(item: WorkItem, request: RecoverRequest, slots: Readonly<Record<string, ErrorSlot>>, inline: HTMLElement): Promise<void> {
    if (recovering) {
      ctx.announce('Another recovery is still being processed. Wait for it to finish.');
      return;
    }
    recovering = true;
    try {
      const accepted = await ctx.api.recoverWorkItem(item.workId, request, ctx.signal);
      showStatus(recoveredNotice(item, accepted));
      void load(true);
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) {
        // The item changed since this list was read. Say why it was refused, then show what it is now.
        showStatus(errorBanner(error, { signOut: ctx.signOut }));
        void load(true);
        return;
      }
      const split = splitFieldErrors(error instanceof ApiError ? (error.problem?.errors ?? []) : [], recoverFieldOf);
      if (Object.keys(split.fields).length > 0) applyFieldErrors(slots, split.fields);
      replaceContent(inline, errorBanner(error, { signOut: ctx.signOut }));
    } finally {
      recovering = false;
    }
  }

  function recoverForm(item: WorkItem, action: RecoverAction, close: () => void): { readonly element: HTMLElement; focus(): void } {
    const resume = action === 'resume';
    const reason = field('Reason', h('textarea', { name: 'reason', rows: 3 }), `Required, up to ${String(REASON_MAX)} characters. It is stored with the case timeline.`);
    const slots: Record<string, ErrorSlot> = { reason };
    const allowanceInputs = new Map<string, HTMLInputElement>();
    const allowanceFields = ALLOWANCE_FIELDS.map((spec) => {
      const input = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', name: spec.key });
      const entry = field(spec.label, input, `A whole number from ${String(spec.min)} to ${String(spec.max)}, or leave it empty.`);
      allowanceInputs.set(spec.key, input);
      slots[spec.key] = entry;
      return entry.element;
    });
    const failure = formErrorSlot();
    slots['allowance'] = failure.slot;
    const inline = h('div', { class: 'submit-error' });
    const submitButton = h('button', { type: 'submit', class: 'primary' }, resume ? 'Resume run' : 'Requeue');

    async function submit(): Promise<void> {
      await whileBusy(submitButton, resume ? 'Resuming…' : 'Requeuing…', async () => {
        replaceContent(inline);
        const built = buildRecover({
          action,
          reason: reason.control.value,
          allowance: Object.fromEntries([...allowanceInputs].map(([key, input]): [string, string] => [key, input.value])),
        });
        if (!built.ok) {
          const count = applyFieldErrors(slots, built.errors);
          ctx.announce(`${String(count)} ${count === 1 ? 'field needs' : 'fields need'} attention.`);
          return;
        }
        applyFieldErrors(slots, {});
        await send(item, built.value, slots, inline);
      });
    }

    const element = h(
      'form',
      {
        class: 'form recover-form',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          void submit();
        },
      },
      h('h3', null, resume ? 'Resume this run with an allowance' : 'Requeue this work item'),
      h('p', { class: 'hint' }, resume ? RESUME_TEXT : REQUEUE_TEXT),
      reason.element,
      resume ? h('fieldset', { class: 'allowance' }, h('legend', null, 'Allowance to grant'), allowanceFields, failure.element) : null,
      inline,
      h('div', { class: 'actions' }, submitButton, button('Cancel', close, { class: 'secondary' })),
    );
    return {
      element,
      focus: () => {
        reason.control.focus();
      },
    };
  }

  /** At most one recovery form is open at a time, so one person cannot have two half-filled requests in flight. */
  function openRecover(item: WorkItem, action: RecoverAction, region: HTMLElement, opener: HTMLElement): void {
    closeOpenForm?.();
    const close = (): void => {
      replaceContent(region);
      closeOpenForm = null;
    };
    // Cancel removes the button that has focus, so focus goes back to the button that opened the form.
    const form = recoverForm(item, action, () => {
      close();
      opener.focus();
    });
    closeOpenForm = close;
    replaceContent(region, form.element);
    form.focus();
  }

  function workCard(item: WorkItem): HTMLLIElement {
    const formRegion = h('div', { class: 'recover-region' });
    const kind = workKindLabel(item.kind);
    const controls: Child[] = item.actions.map((action) => {
      const opener: HTMLButtonElement = button(
        actionLabel(action),
        () => {
          openRecover(item, action, formRegion, opener);
        },
        { class: 'secondary', 'aria-label': `${actionLabel(action)} for the ${kind.toLowerCase()} of case ${shortCaseId(item.caseId)}` },
      );
      return opener;
    });
    return h(
      'li',
      { class: 'card work-item' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', { class: 'card-title' }, `${kind} for case ${shortCaseId(item.caseId)}`),
        badge(workStateLabel(item.state), workStateTone(item.state)),
      ),
      h('p', { class: 'work-summary' }, item.summary),
      definitionList([
        ['Case', h('a', { href: caseHash(item.caseId) }, shortCaseId(item.caseId))],
        ['Attempts', String(item.attempts)],
        ['Last error', item.lastError === null ? 'none' : h('span', null, h('code', null, item.lastError.code), ': ', item.lastError.message)],
        ['Claimed until', item.claimedUntil === null ? 'not claimed' : timeText(item.claimedUntil)],
        ['Created', timeText(item.createdAt)],
        ['Updated', timeText(item.updatedAt)],
        ['Work id', h('code', null, item.workId)],
      ]),
      usageDetails(item),
      h('div', { class: 'actions work-actions' }, controls.length === 0 ? h('p', { class: 'hint' }, noActionText(item)) : controls),
      formRegion,
    );
  }

  async function load(reset: boolean): Promise<void> {
    if (reset) {
      generation += 1;
    } else if (loading) {
      return;
    }
    const mine = generation;
    loading = true;
    if (reset) {
      shown = 0;
      token = null;
      cards = null;
      closeOpenForm = null;
      replaceContent(listRegion, loadingNote('Loading work items…'));
      replaceContent(moreRegion);
    } else {
      replaceContent(moreRegion, loadingNote('Loading more work items…'));
    }
    try {
      const page = await ctx.api.listOperatorWork(filter, { limit: pageSize, continuationToken: token ?? undefined, signal: ctx.signal });
      if (mine !== generation) return;
      const fresh = page.items.map(workCard);
      shown += fresh.length;
      token = page.continuationToken;
      if (cards === null) {
        if (fresh.length === 0) {
          replaceContent(listRegion, h('p', { class: 'empty' }, `There is no work in the “${workStateLabel(filter)}” state.`));
        } else {
          cards = h('ul', { class: 'cards' }, fresh);
          replaceContent(listRegion, cards);
        }
      } else {
        cards.append(...fresh);
      }
      if (token !== null) {
        replaceContent(
          moreRegion,
          button('Load more', () => {
            void load(false);
          }, { class: 'secondary' }),
        );
      } else {
        replaceContent(moreRegion, shown === 0 ? null : h('p', { class: 'end-note' }, `${String(shown)} ${shown === 1 ? 'item' : 'items'} shown. That is all of them.`));
      }
      if (reset) {
        ctx.announce(`${String(shown)} ${shown === 1 ? 'work item' : 'work items'} loaded.`);
      } else {
        ctx.announce(`${String(fresh.length)} more work ${fresh.length === 1 ? 'item' : 'items'} loaded.`);
        fresh[0]?.querySelector('a')?.focus();
      }
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted || mine !== generation) return;
      replaceContent(
        reset ? listRegion : moreRegion,
        errorBanner(error, {
          signOut: ctx.signOut,
          retry: () => {
            void load(reset);
          },
        }),
      );
    } finally {
      if (mine === generation) loading = false;
    }
  }

  replaceContent(
    host,
    h('h1', null, 'Operator recovery'),
    h(
      'p',
      { class: 'lede' },
      `Work for the ${ctx.session.principal.tenantId} tenant, newest first. Recovery keeps recorded usage and any credit already issued, and it never approves anything.`,
    ),
    h(
      'div',
      { class: 'toolbar' },
      labelled('Work state', stateSelect),
      labelled('Per page', sizeSelect),
      button('Refresh', () => {
        void load(true);
      }, { class: 'secondary' }),
    ),
    help,
    statusRegion,
    listRegion,
    moreRegion,
  );
  void load(true);
}
