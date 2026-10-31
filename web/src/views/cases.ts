import { button, h, replaceContent } from '../dom.ts';
import { isAbort } from '../errors.ts';
import { actorText, CASE_STATUSES, formatMoney, proposalStatusLabel, statusInfo } from '../format.ts';
import { categoryLabel } from '../forms.ts';
import { caseHash, routeHash } from '../routes.ts';
import type { CaseStatus, CaseSummary, ProposalBrief } from '../types.ts';
import { definitionList, errorBanner, labelled, loadingNote, shortCaseId, statusBadge, timeText } from './common.ts';
import { hasRole, type ViewContext } from './context.ts';

const PAGE_SIZES = [5, 10, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;

const isCaseStatus = (value: string): value is CaseStatus => CASE_STATUSES.includes(value);

function proposalBrief(brief: ProposalBrief | null): string {
  if (brief === null) return 'None yet';
  const status = proposalStatusLabel(brief.status);
  if (brief.kind === 'finding' || brief.amount === null) return `Version ${String(brief.version)}: finding (${status})`;
  return `Version ${String(brief.version)}: credit ${formatMoney(brief.amount)} (${status})`;
}

function caseCard(item: CaseSummary, principalId: string): HTMLLIElement {
  return h(
    'li',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', { class: 'card-title' }, h('a', { href: caseHash(item.caseId) }, `Case ${shortCaseId(item.caseId)}`)),
      statusBadge(item.status),
    ),
    definitionList([
      ['Category', categoryLabel(item.category)],
      ['Account', item.accountId],
      ['Proposal', proposalBrief(item.latestProposal)],
      ['Opened by', actorText(item.createdBy, principalId)],
      ['Updated', timeText(item.updatedAt)],
    ]),
  );
}

/** The tenant's cases, newest first, a page at a time. A change of filter or page size starts over. */
export function mountCases(host: HTMLElement, ctx: ViewContext): void {
  const principalId = ctx.session.principal.principalId;
  const canCreate = hasRole(ctx.session, 'Representative');

  // A response that arrives after the filter changed belongs to an earlier generation and is dropped.
  let generation = 0;
  let loading = false;
  let shown = 0;
  let token: string | null = null;
  let filter: CaseStatus | null = null;
  let pageSize: number = DEFAULT_PAGE_SIZE;
  let cards: HTMLUListElement | null = null;

  const listRegion = h('div', { class: 'list-region' });
  const moreRegion = h('div', { class: 'more-region' });

  const statusSelect: HTMLSelectElement = h(
    'select',
    {
      onchange: () => {
        filter = isCaseStatus(statusSelect.value) ? statusSelect.value : null;
        void load(true);
      },
    },
    h('option', { value: '' }, 'All statuses'),
    CASE_STATUSES.map((status) => h('option', { value: status }, statusInfo(status).label)),
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

  const emptyText = (): string => {
    if (filter !== null) return `There are no disputes with the status “${statusInfo(filter).label}”.`;
    return canCreate ? 'There are no disputes yet. Use “New dispute” to open one.' : 'There are no disputes yet.';
  };

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
      replaceContent(listRegion, loadingNote('Loading disputes…'));
      replaceContent(moreRegion);
    } else {
      replaceContent(moreRegion, loadingNote('Loading more disputes…'));
    }
    try {
      const page = await ctx.api.listCases({
        status: filter ?? undefined,
        limit: pageSize,
        continuationToken: token ?? undefined,
        signal: ctx.signal,
      });
      if (mine !== generation) return;
      const fresh = page.items.map((item) => caseCard(item, principalId));
      shown += fresh.length;
      token = page.continuationToken;
      if (cards === null) {
        if (fresh.length === 0) {
          replaceContent(listRegion, h('p', { class: 'empty' }, emptyText()));
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
        replaceContent(moreRegion, shown === 0 ? null : h('p', { class: 'end-note' }, `${String(shown)} ${shown === 1 ? 'dispute' : 'disputes'} shown. That is all of them.`));
      }
      if (reset) {
        ctx.announce(`${String(shown)} ${shown === 1 ? 'dispute' : 'disputes'} loaded.`);
      } else {
        ctx.announce(`${String(fresh.length)} more ${fresh.length === 1 ? 'dispute' : 'disputes'} loaded.`);
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
    h('h1', null, 'Cases'),
    h('p', { class: 'lede' }, `Disputes for the ${ctx.session.principal.tenantId} tenant, newest first. Every credit in this sample is simulated.`),
    h(
      'div',
      { class: 'toolbar' },
      labelled('Status', statusSelect),
      labelled('Per page', sizeSelect),
      button('Refresh', () => {
        void load(true);
      }, { class: 'secondary' }),
      canCreate ? h('a', { class: 'button', href: routeHash({ name: 'new-case' }) }, 'New dispute') : null,
    ),
    listRegion,
    moreRegion,
  );
  void load(true);
}
