import { h, replaceContent, type Child } from '../dom.ts';
import { describeError, isAbort } from '../errors.ts';
import { formatTimestamp, statusInfo, type Tone } from '../format.ts';
import { routeHash } from '../routes.ts';
import type { ViewContext } from './context.ts';

let lastId = 0;

/** A page-unique id, for tying a label or description to its control. */
export function uid(prefix: string): string {
  lastId += 1;
  return `${prefix}-${String(lastId)}`;
}

export interface BannerActions {
  readonly retry?: (() => void) | undefined;
  readonly signOut?: (() => void) | undefined;
}

/**
 * A failure as the person should see it: what happened, the stable code, and the correlation id that finds the
 * server-side trace. An expired sign-in offers a way back to sign-in; a retryable failure offers a retry.
 */
export function errorBanner(error: unknown, actions: BannerActions = {}): HTMLElement {
  const view = describeError(error);
  const identifiers = [
    view.code === null ? null : `Code ${view.code}`,
    view.status === null ? null : `HTTP ${String(view.status)}`,
    view.correlationId === null ? null : `Correlation id ${view.correlationId}`,
  ].filter((part): part is string => part !== null);
  const buttons: HTMLElement[] = [];
  if (view.kind === 'auth' && actions.signOut !== undefined) {
    const signOut = actions.signOut;
    buttons.push(h('button', { type: 'button', class: 'secondary', onclick: () => { signOut(); } }, 'Sign out'));
  }
  if (actions.retry !== undefined) {
    const retry = actions.retry;
    buttons.push(h('button', { type: 'button', class: 'secondary', onclick: () => { retry(); } }, 'Try again'));
  }
  return h(
    'div',
    { class: 'banner banner-error', role: 'alert' },
    h('p', { class: 'banner-title' }, view.title),
    view.detail === null ? null : h('p', null, view.detail),
    view.fields.length === 0
      ? null
      : h('ul', { class: 'problem-fields' }, view.fields.map((fieldError) => h('li', null, h('code', null, fieldError.pointer), ': ', fieldError.message))),
    view.retryAfterSeconds === null ? null : h('p', null, `The service asks you to wait ${String(view.retryAfterSeconds)} seconds before trying again.`),
    identifiers.length === 0 ? null : h('p', { class: 'meta' }, identifiers.join(' · ')),
    buttons.length === 0 ? null : h('div', { class: 'actions' }, buttons),
  );
}

/** Runs `task`. A failure other than "the person moved on" is shown as a banner inside `target`. */
export async function guarded(ctx: ViewContext, target: Element, task: () => Promise<void>, retry?: () => void): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (isAbort(error) || ctx.signal.aborted) return;
    replaceContent(target, errorBanner(error, { retry, signOut: ctx.signOut }));
  }
}

/**
 * Runs a submit. While it runs the button reports itself busy and ignores further clicks, so a double click cannot
 * send two requests. `aria-disabled` is used instead of `disabled` so focus stays on the button.
 */
export async function whileBusy(submit: HTMLButtonElement, busyLabel: string, task: () => Promise<void>): Promise<void> {
  if (submit.getAttribute('aria-disabled') === 'true') return;
  const label = submit.textContent;
  submit.setAttribute('aria-disabled', 'true');
  submit.textContent = busyLabel;
  try {
    await task();
  } finally {
    submit.removeAttribute('aria-disabled');
    submit.textContent = label;
  }
}

export const loadingNote = (text: string): HTMLElement => h('p', { class: 'loading', role: 'status' }, text);

export type NoticeTone = 'info' | 'success' | 'warning';

export const notice = (tone: NoticeTone, ...children: Child[]): HTMLElement => h('div', { class: `banner banner-${tone}`, role: 'status' }, ...children);

export function badge(label: string, tone: Tone): HTMLElement {
  return h('span', { class: `badge tone-${tone}` }, label);
}

export function statusBadge(status: string): HTMLElement {
  const info = statusInfo(status);
  return badge(info.label, info.tone);
}

export const timeText = (value: string | null): Child => (value === null ? 'not yet' : h('time', { datetime: value }, formatTimestamp(value)));

export const shortCaseId = (caseId: string): string => caseId.slice(0, 13);

export const backToCases = (): HTMLElement => h('p', { class: 'back' }, h('a', { href: routeHash({ name: 'cases' }) }, '← All cases'));

export function definitionList(rows: readonly (readonly [string, Child])[], className = 'facts'): HTMLElement {
  return h('dl', { class: className }, rows.map(([term, value]) => h('div', { class: 'fact' }, h('dt', null, term), h('dd', null, value))));
}

/** A titled block. The heading is an h2 under the page's single h1. */
export function panel(title: string, ...children: Child[]): HTMLElement {
  const headingId = uid('panel');
  return h('section', { class: 'panel', 'aria-labelledby': headingId }, h('h2', { id: headingId }, title), ...children);
}

export type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Somewhere an error can be shown and keyboard focus can be sent. */
export interface ErrorSlot {
  readonly control: { focus(): void };
  setError(message: string | null): void;
}

export interface Field<C extends FormControl> extends ErrorSlot {
  readonly element: HTMLElement;
  readonly control: C;
}

/**
 * A labelled control with an optional hint and a place for its error. The error element exists from the start, so
 * showing or clearing an error never rebuilds the control and the person's input and focus are kept.
 */
export function field<C extends FormControl>(label: string, control: C, hint: string | null = null): Field<C> {
  const id = uid('field');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  control.id = id;
  control.setAttribute('aria-describedby', hint === null ? errorId : `${hintId} ${errorId}`);
  const error = h('p', { class: 'field-error', id: errorId, hidden: true });
  const element = h('div', { class: 'field' }, h('label', { for: id }, label), hint === null ? null : h('p', { class: 'hint', id: hintId }, hint), control, error);
  return {
    element,
    control,
    setError(message) {
      error.textContent = message === null ? '' : `Error: ${message}`;
      error.hidden = message === null;
      element.classList.toggle('has-error', message !== null);
      if (message === null) control.removeAttribute('aria-invalid');
      else control.setAttribute('aria-invalid', 'true');
    },
  };
}

/** Shows each error under its field, clears the rest, and focuses the first field with an error. Returns how many there were. */
export function applyFieldErrors(fields: Readonly<Record<string, ErrorSlot>>, errors: Readonly<Record<string, string>>): number {
  let first: ErrorSlot['control'] | null = null;
  let count = 0;
  for (const [key, entry] of Object.entries(fields)) {
    const message = errors[key];
    entry.setError(message ?? null);
    if (message !== undefined) {
      count += 1;
      first ??= entry.control;
    }
  }
  first?.focus();
  return count;
}

/** A labelled control with no error slot, for filters and toolbars. */
export function labelled(label: string, control: FormControl): HTMLElement {
  const id = uid('control');
  control.id = id;
  return h('div', { class: 'field field-inline' }, h('label', { for: id }, label), control);
}

/** An error that concerns a whole form rather than one control. It can take focus so the message is reached. */
export function formErrorSlot(): { readonly element: HTMLElement; readonly slot: ErrorSlot } {
  const element = h('p', { class: 'field-error', role: 'alert', tabindex: -1, hidden: true });
  return {
    element,
    slot: {
      control: element,
      setError(message) {
        element.textContent = message === null ? '' : `Error: ${message}`;
        element.hidden = message === null;
      },
    },
  };
}
