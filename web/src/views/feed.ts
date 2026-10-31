import type { PageOptions } from '../api.ts';
import { button, h, replaceContent } from '../dom.ts';
import { isAbort } from '../errors.ts';
import { planFeedUpdate } from '../feed-plan.ts';
import { errorBanner, loadingNote, whileBusy } from './common.ts';
import type { ViewContext } from './context.ts';

interface FeedPage<T> {
  readonly items: readonly T[];
  readonly continuationToken: string | null;
}

export interface FeedOptions<T extends { readonly seq: number }> {
  readonly ctx: ViewContext;
  readonly noun: { readonly one: string; readonly many: string };
  readonly pageSize: number;
  readonly emptyText: string;
  readonly loadingText: string;
  readonly fetchPage: (options: PageOptions) => Promise<FeedPage<T>>;
  readonly renderItem: (item: T) => HTMLLIElement;
  /**
   * For a list whose entries are updated in place after they are recorded: a string that differs whenever what an
   * entry shows differs. Without it an entry is drawn once and never again.
   */
  readonly revisionOf?: (item: T) => string;
}

export interface Feed {
  readonly element: HTMLElement;
  /** Shows the first page, or, once something is shown, picks up entries appended since. */
  refresh(): Promise<void>;
  /** Forgets everything shown, for when the thing the feed describes has changed. */
  reset(): void;
}

type Step = 'first' | 'more' | 'refresh';

/**
 * A list that grows at the end and is read a page at a time. Entries are ordered by `seq`. A refresh adds what is newer
 * and leaves focus and scroll position alone. Only a list that passes `revisionOf` also draws again an entry that was
 * updated in place after it was shown.
 */
export function createFeed<T extends { readonly seq: number }>(options: FeedOptions<T>): Feed {
  const { ctx, pageSize } = options;

  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let loaded = false;
  let shown = 0;
  let lastSeq: number | null = null;
  // The token that fetched the last page, and the one the service gave back for the page after it. A token is a
  // position in the ordering, so fetching the last page again returns it plus whatever has been appended since.
  let lastPageToken: string | null = null;
  let nextToken: string | null = null;
  let list: HTMLOListElement | null = null;
  // Kept only for a list that redraws entries: the node each entry is shown in and what it was drawn from.
  const nodeBySeq = new Map<number, HTMLLIElement>();
  const revisions = new Map<number, string>();

  const listRegion = h('div', { class: 'feed-list' });
  const errorRegion = h('div', { class: 'feed-error' });
  const moreRegion = h('div', { class: 'feed-more' });
  const element = h('div', { class: 'feed' }, listRegion, errorRegion, moreRegion);

  const noun = (count: number): string => (count === 1 ? options.noun.one : options.noun.many);

  function renderMore(): void {
    if (nextToken === null) {
      replaceContent(moreRegion, shown === 0 ? null : h('p', { class: 'end-note' }, `${String(shown)} ${noun(shown)} shown. That is everything recorded so far.`));
      return;
    }
    const more: HTMLButtonElement = button(
      'Load more',
      () => {
        void whileBusy(more, 'Loading…', () => enqueue(() => step('more')));
      },
      { class: 'secondary' },
    );
    replaceContent(moreRegion, h('p', { class: 'end-note' }, `${String(shown)} ${noun(shown)} shown. There are more.`), more);
  }

  function track(item: T, node: HTMLLIElement): HTMLLIElement {
    if (options.revisionOf !== undefined) {
      nodeBySeq.set(item.seq, node);
      revisions.set(item.seq, options.revisionOf(item));
    }
    return node;
  }

  // Draws an entry again where it already is. A node that holds focus keeps it, and the page does not scroll.
  function redraw(changed: readonly T[]): void {
    for (const item of changed) {
      const old = nodeBySeq.get(item.seq);
      if (old === undefined) continue;
      const next = track(item, options.renderItem(item));
      const hadFocus = old.contains(document.activeElement);
      old.replaceWith(next);
      if (hadFocus) {
        next.tabIndex = -1;
        next.focus({ preventScroll: true });
      }
    }
  }

  function append(fresh: readonly T[], mode: Step): void {
    if (fresh.length === 0) {
      if (list === null) replaceContent(listRegion, h('p', { class: 'empty' }, options.emptyText));
      return;
    }
    const nodes = fresh.map((item) => track(item, options.renderItem(item)));
    for (const item of fresh) {
      if (lastSeq === null || item.seq > lastSeq) lastSeq = item.seq;
    }
    shown += fresh.length;
    if (list === null) {
      list = h('ol', { class: 'feed-items' }, nodes);
      replaceContent(listRegion, list);
    } else {
      list.append(...nodes);
    }
    const first = nodes[0];
    if (mode === 'more' && first !== undefined) {
      first.tabIndex = -1;
      first.focus();
    }
  }

  async function step(mode: Step): Promise<void> {
    const mine = generation;
    if (mode === 'refresh' && nextToken !== null) return;
    const token = mode === 'first' ? null : mode === 'more' ? nextToken : lastPageToken;
    if (mode === 'more' && token === null) return;
    const seen = lastSeq;
    if (!loaded) replaceContent(listRegion, loadingNote(options.loadingText));
    try {
      const page = await options.fetchPage({ limit: pageSize, continuationToken: token ?? undefined, signal: ctx.signal });
      if (mine !== generation) return;
      if (mode === 'first') lastPageToken = null;
      else if (mode === 'more') lastPageToken = token;
      nextToken = page.continuationToken;
      const plan = planFeedUpdate(page.items, { newest: seen, revisions }, options.revisionOf);
      redraw(plan.changed);
      loaded = true;
      replaceContent(errorRegion);
      append(plan.fresh, mode);
      renderMore();
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted || mine !== generation) return;
      if (!loaded) replaceContent(listRegion);
      replaceContent(
        errorRegion,
        errorBanner(error, {
          signOut: ctx.signOut,
          retry: () => {
            void enqueue(() => step(loaded ? 'refresh' : 'first'));
          },
        }),
      );
    }
  }

  // Steps run one at a time, so a refresh never overlaps a "Load more".
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch(() => undefined);
    return queue;
  }

  return {
    element,
    refresh: () => enqueue(() => step(loaded ? 'refresh' : 'first')),
    reset() {
      generation += 1;
      loaded = false;
      shown = 0;
      lastSeq = null;
      nodeBySeq.clear();
      revisions.clear();
      lastPageToken = null;
      nextToken = null;
      list = null;
      replaceContent(listRegion);
      replaceContent(errorRegion);
      replaceContent(moreRegion);
    },
  };
}
