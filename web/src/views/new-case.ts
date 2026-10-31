import { button, h, replaceContent } from '../dom.ts';
import { ApiError, isAbort } from '../errors.ts';
import { formatMoney } from '../format.ts';
import { buildCreateCase, CATEGORIES, characterCount, CURRENCIES, DESCRIPTION_MAX, ID_PATTERN, MAX_INVOICES, newIdempotencyKey, splitFieldErrors } from '../forms.ts';
import { hintsFor } from '../personas.ts';
import { caseHash } from '../routes.ts';
import type { Account, CaseAccepted, Invoice } from '../types.ts';
import {
  applyFieldErrors,
  backToCases,
  definitionList,
  errorBanner,
  field,
  loadingNote,
  notice,
  panel,
  statusBadge,
  uid,
  whileBusy,
  type ErrorSlot,
} from './common.ts';
import { hasRole, type ViewContext } from './context.ts';

const INVOICE_PAGE = 50;

const randomKey = (): string => newIdempotencyKey((length) => crypto.getRandomValues(new Uint8Array(length)));

function accountSummary(account: Account): HTMLElement {
  return h(
    'div',
    { class: 'account-summary' },
    h('p', null, h('strong', null, account.displayName), ` (${account.accountId}): ${account.currency}, ${account.status}`),
    account.subscriptions.length === 0
      ? null
      : h('ul', { class: 'plain' }, account.subscriptions.map((subscription) => h('li', null, `${subscription.plan}: ${formatMoney(subscription.monthlyAmount)} a month (${subscription.status})`))),
  );
}

/** The form a Representative uses to open a dispute. */
export function mountNewCase(host: HTMLElement, ctx: ViewContext): void {
  if (!hasRole(ctx.session, 'Representative')) {
    replaceContent(host, backToCases(), h('h1', null, 'New dispute'), notice('warning', 'Only a Representative can open a dispute. Your sign-in does not have that role.'));
    return;
  }

  let lookedUp: Account | null = null;
  let lookupGeneration = 0;
  let invoiceToken: string | null = null;
  const selected = new Set<string>();
  const boxes = new Map<string, HTMLInputElement>();

  const accountInput: HTMLInputElement = h('input', {
    type: 'text',
    name: 'accountId',
    autocomplete: 'off',
    spellcheck: 'false',
    required: true,
    oninput: () => {
      if (lookedUp !== null && accountInput.value.trim() !== lookedUp.accountId) resetLookup();
    },
    onkeydown: (event) => {
      if (event instanceof KeyboardEvent && event.key === 'Enter') {
        event.preventDefault();
        void lookup();
      }
    },
  });
  const accountField = field('Account id', accountInput, 'The fictional customer account the dispute is about. Press Enter or use Look up account to see its invoices.');
  const lookupRegion = h('div', { class: 'lookup-region' });

  const invoiceList = h('div', { class: 'checks' });
  const invoiceCount = h('p', { class: 'hint', role: 'status' });
  const invoiceMore = h('div', { class: 'more-region' });
  const invoiceError = h('p', { class: 'field-error', id: uid('invoices-error'), hidden: true });
  const invoiceGroup = h(
    'fieldset',
    { class: 'field invoice-group', tabindex: -1 },
    h('legend', null, `Invoices in dispute (optional, up to ${String(MAX_INVOICES)})`),
    invoiceCount,
    invoiceList,
    invoiceMore,
    invoiceError,
  );
  const invoiceSlot: ErrorSlot = {
    control: invoiceGroup,
    setError(message) {
      invoiceError.textContent = message === null ? '' : `Error: ${message}`;
      invoiceError.hidden = message === null;
      invoiceGroup.classList.toggle('has-error', message !== null);
    },
  };

  const categorySelect = h(
    'select',
    { name: 'category', required: true },
    h('option', { value: '' }, 'Choose a category'),
    CATEGORIES.map((category) => h('option', { value: category.value }, category.label)),
  );
  const categoryField = field('Category', categorySelect);

  const amountInput = h('input', { type: 'text', name: 'requestedAmount', inputmode: 'decimal', autocomplete: 'off' });
  const amountField = field('Requested credit (optional)', amountInput, 'In major units, for example 49.50. Leave it blank when you are not asking for a specific amount.');
  const currencySelect = h('select', { name: 'currency' }, CURRENCIES.map((currency) => h('option', { value: currency }, currency)));
  const currencyField = field('Currency', currencySelect);

  const counter = h('p', { class: 'counter' });
  const descriptionInput = h('textarea', {
    name: 'description',
    rows: 6,
    required: true,
    oninput: () => {
      updateCounter();
    },
  });
  const descriptionField = field(
    'What happened?',
    descriptionInput,
    `Plain text, up to ${String(DESCRIPTION_MAX)} characters. The agent treats it as untrusted data, never as instructions.`,
  );

  const keyInput = h('input', { type: 'text', name: 'idempotencyKey', autocomplete: 'off', spellcheck: 'false', value: randomKey() });
  const keyField = field(
    'Idempotency key',
    keyInput,
    'Sending the same key with identical content returns the original dispute instead of opening another. The same key with different content is refused with a conflict. A key counts only for your tenant and your user, and is kept as long as the dispute exists.',
  );

  const submitError = h('div', { class: 'submit-error' });
  const submitButton = h('button', { type: 'submit', class: 'primary' }, 'Submit dispute');

  const slots: Record<string, ErrorSlot> = {
    accountId: accountField,
    invoiceIds: invoiceSlot,
    category: categoryField,
    requestedAmount: amountField,
    currency: currencyField,
    description: descriptionField,
    idempotencyKey: keyField,
  };

  function updateCounter(): void {
    const used = characterCount(descriptionInput.value);
    counter.textContent = `${String(used)} of ${String(DESCRIPTION_MAX)} characters${used > DESCRIPTION_MAX ? ' (too long)' : ''}`;
  }

  function syncInvoiceBoxes(): void {
    const full = selected.size >= MAX_INVOICES;
    for (const [invoiceId, box] of boxes) box.disabled = full && !selected.has(invoiceId);
    invoiceCount.textContent = `${String(selected.size)} of ${String(MAX_INVOICES)} selected${full ? '. Clear one to choose another.' : '.'}`;
    invoiceSlot.setError(null);
  }

  function invoiceBox(invoice: Invoice): HTMLElement {
    const box: HTMLInputElement = h('input', {
      type: 'checkbox',
      name: 'invoiceIds',
      value: invoice.invoiceId,
      onchange: () => {
        if (box.checked) selected.add(invoice.invoiceId);
        else selected.delete(invoice.invoiceId);
        syncInvoiceBoxes();
      },
    });
    box.checked = selected.has(invoice.invoiceId);
    boxes.set(invoice.invoiceId, box);
    return h(
      'label',
      { class: 'check' },
      box,
      h('span', null, `${invoice.number} (${invoice.invoiceId}): ${invoice.periodStart} to ${invoice.periodEnd}, ${formatMoney(invoice.total)}, ${invoice.status}`),
    );
  }

  function renderInvoiceMore(): void {
    replaceContent(
      invoiceMore,
      invoiceToken === null
        ? null
        : button('Load more invoices', () => {
            void loadMoreInvoices();
          }, { class: 'secondary' }),
    );
  }

  function resetLookup(): void {
    lookupGeneration += 1;
    lookedUp = null;
    invoiceToken = null;
    selected.clear();
    boxes.clear();
    replaceContent(lookupRegion);
    replaceContent(invoiceList, h('p', { class: 'hint' }, 'Look up the account to choose the invoices you are disputing, or leave this empty.'));
    replaceContent(invoiceMore);
    syncInvoiceBoxes();
  }

  async function lookup(): Promise<void> {
    const accountId = accountInput.value.trim();
    if (!ID_PATTERN.test(accountId)) {
      accountField.setError('Enter an account id such as acct_aurora_0001.');
      accountInput.focus();
      return;
    }
    accountField.setError(null);
    resetLookup();
    const mine = lookupGeneration;
    replaceContent(lookupRegion, loadingNote('Looking up the account…'));
    try {
      const [account, invoices] = await Promise.all([
        ctx.api.getAccount(accountId, ctx.signal),
        ctx.api.listInvoices(accountId, { limit: INVOICE_PAGE, signal: ctx.signal }),
      ]);
      if (mine !== lookupGeneration) return;
      lookedUp = account;
      invoiceToken = invoices.continuationToken;
      replaceContent(lookupRegion, accountSummary(account));
      replaceContent(invoiceList, invoices.items.length === 0 ? h('p', { class: 'hint' }, 'This account has no invoices.') : null);
      for (const invoice of invoices.items) invoiceList.append(invoiceBox(invoice));
      renderInvoiceMore();
      syncInvoiceBoxes();
      if (amountInput.value.trim() === '') currencySelect.value = account.currency;
      ctx.announce(`Found ${account.displayName}, with ${String(invoices.items.length)} ${invoices.items.length === 1 ? 'invoice' : 'invoices'}${invoiceToken === null ? '' : ' shown so far'}.`);
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted || mine !== lookupGeneration) return;
      if (error instanceof ApiError && error.status === 404) {
        replaceContent(lookupRegion);
        accountField.setError('No such account for this tenant.');
        accountInput.focus();
        return;
      }
      replaceContent(
        lookupRegion,
        errorBanner(error, {
          signOut: ctx.signOut,
          retry: () => {
            void lookup();
          },
        }),
      );
    }
  }

  async function loadMoreInvoices(): Promise<void> {
    const account = lookedUp;
    const after = invoiceToken;
    if (account === null || after === null) return;
    const mine = lookupGeneration;
    replaceContent(invoiceMore, loadingNote('Loading more invoices…'));
    try {
      const page = await ctx.api.listInvoices(account.accountId, { limit: INVOICE_PAGE, continuationToken: after, signal: ctx.signal });
      if (mine !== lookupGeneration) return;
      invoiceToken = page.continuationToken;
      for (const invoice of page.items) invoiceList.append(invoiceBox(invoice));
      renderInvoiceMore();
      syncInvoiceBoxes();
      ctx.announce(`${String(page.items.length)} more ${page.items.length === 1 ? 'invoice' : 'invoices'} loaded.`);
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted || mine !== lookupGeneration) return;
      replaceContent(
        invoiceMore,
        errorBanner(error, {
          signOut: ctx.signOut,
          retry: () => {
            void loadMoreInvoices();
          },
        }),
      );
    }
  }

  function showReplay(accepted: CaseAccepted): void {
    replaceContent(
      host,
      backToCases(),
      h('h1', null, 'Dispute already submitted'),
      notice('info', h('p', null, 'This idempotency key was already used with identical content, so no new dispute was opened. The original dispute is returned.')),
      definitionList([
        ['Case', accepted.case.caseId],
        ['Status', statusBadge(accepted.case.status)],
        ['Investigation run', accepted.runId],
      ]),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'button', href: caseHash(accepted.case.caseId) }, 'Open the case'),
        button('Submit another dispute', () => {
          mountNewCase(host, ctx);
        }, { class: 'secondary' }),
      ),
    );
    ctx.announce('This key was already used with identical content. The original dispute is shown.');
  }

  async function submit(): Promise<void> {
    await whileBusy(submitButton, 'Submitting…', async () => {
      replaceContent(submitError);
      const built = buildCreateCase({
        accountId: accountInput.value,
        invoiceIds: [...selected],
        category: categorySelect.value,
        requestedAmount: amountInput.value,
        currency: currencySelect.value,
        description: descriptionInput.value,
        idempotencyKey: keyInput.value.trim(),
      });
      if (!built.ok) {
        const count = applyFieldErrors(slots, built.errors);
        ctx.announce(`${String(count)} ${count === 1 ? 'field needs' : 'fields need'} attention.`);
        return;
      }
      applyFieldErrors(slots, {});
      try {
        const accepted = await ctx.api.createCase(built.value.request, built.value.idempotencyKey, ctx.signal);
        if (accepted.replayed) showReplay(accepted);
        else ctx.navigate(caseHash(accepted.case.caseId));
      } catch (error) {
        if (isAbort(error) || ctx.signal.aborted) return;
        const problemErrors = error instanceof ApiError ? (error.problem?.errors ?? []) : [];
        const split = splitFieldErrors(problemErrors);
        if (Object.keys(split.fields).length > 0) applyFieldErrors(slots, split.fields);
        replaceContent(submitError, errorBanner(error, { signOut: ctx.signOut }));
      }
    });
  }

  const hints = hintsFor(ctx.session.principal.tenantId);
  const hintBlock =
    hints.length === 0
      ? null
      : h(
          'details',
          { class: 'hints' },
          h('summary', null, `Seeded demo accounts for ${ctx.session.principal.tenantId}`),
          h(
            'ul',
            { class: 'plain' },
            hints.map((hint) =>
              h(
                'li',
                null,
                h('strong', null, hint.name),
                ' ',
                h('code', null, hint.accountId),
                `: ${hint.scenario} `,
                button('Use', () => {
                  accountInput.value = hint.accountId;
                  accountField.setError(null);
                  void lookup();
                }, { class: 'secondary small', 'aria-label': `Use ${hint.name}` }),
              ),
            ),
          ),
        );

  resetLookup();
  updateCounter();
  replaceContent(
    host,
    backToCases(),
    h('h1', null, 'New dispute'),
    h(
      'p',
      { class: 'lede' },
      'An agent investigates the invoices and a credit policy, and proposes a credit. A different person has to approve it. Every credit here is simulated; no money moves.',
    ),
    h(
      'form',
      {
        class: 'form',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          void submit();
        },
      },
      panel(
        'Account',
        accountField.element,
        h('div', { class: 'actions' }, button('Look up account', () => {
          void lookup();
        }, { class: 'secondary' })),
        hintBlock,
        lookupRegion,
        invoiceGroup,
      ),
      panel(
        'The dispute',
        categoryField.element,
        h('div', { class: 'row' }, amountField.element, currencyField.element),
        descriptionField.element,
        counter,
      ),
      panel(
        'Submission',
        h('div', { class: 'row' }, keyField.element, h('div', { class: 'row-action' }, button('New key', () => {
          keyInput.value = randomKey();
          keyField.setError(null);
          ctx.announce('A new idempotency key was generated.');
        }, { class: 'secondary' }))),
        h('div', { class: 'actions' }, submitButton, h('a', { class: 'button secondary', href: '#/cases' }, 'Cancel')),
        submitError,
      ),
    ),
  );
}
