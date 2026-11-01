import { h, type Child } from '../dom.ts';
import { formatCostMicroUsd, formatCount, formatDuration, qualityLabel, usageKindLabel, usageOutcomeLabel } from '../format.ts';
import type { Run, UsageEvent } from '../types.ts';
import { definitionList, timeText } from './common.ts';
import type { ViewContext } from './context.ts';
import { createFeed } from './feed.ts';

const PAGE_SIZE = 20;

/** One call. A tool call has no tokens or cost, so those rows are left out rather than shown as unknown. */
export function usageEntry(event: UsageEvent): HTMLLIElement {
  const rows: (readonly [string, Child])[] = [
    ['Outcome', usageOutcomeLabel(event.outcome)],
    ['Attempt', String(event.attempt)],
  ];
  if (event.tokenQuality !== 'not_applicable') {
    rows.push(['Tokens', `${formatCount(event.inputTokens)} in, ${formatCount(event.outputTokens)} out (${qualityLabel(event.tokenQuality)})`]);
  }
  if (event.costQuality !== 'not_applicable') {
    rows.push(['Cost', `${formatCostMicroUsd(event.costMicroUsd)} (${qualityLabel(event.costQuality)})`]);
  }
  rows.push(['Time taken', event.latencyMs === null ? 'unknown' : formatDuration(event.latencyMs)]);
  if (event.errorCode !== null) rows.push(['Error code', h('code', null, event.errorCode)]);
  return h(
    'li',
    { class: 'timeline-item' },
    h(
      'div',
      { class: 'timeline-head' },
      h('span', { class: 'timeline-seq' }, `#${String(event.seq)}`),
      ' ',
      h('strong', null, `${usageKindLabel(event.kind)}: ${event.name}`),
      ' ',
      timeText(event.at),
    ),
    definitionList(rows),
  );
}

export interface UsageEventsView {
  readonly element: HTMLElement;
  /** Points the list at the case's latest run. Nothing is read until the person opens it. */
  update(run: Run | null): void;
}

/** Every tool and model call of the latest run, read when asked for and kept current while it is open. */
export function mountUsageEvents(ctx: ViewContext, caseId: string): UsageEventsView {
  let runId: string | null = null;
  let signature = '';

  const feed = createFeed<UsageEvent>({
    ctx,
    pageSize: PAGE_SIZE,
    noun: { one: 'call', many: 'calls' },
    emptyText: 'This run has not made any calls yet.',
    loadingText: 'Loading the calls…',
    fetchPage: (options) => (runId === null ? Promise.resolve({ items: [], continuationToken: null }) : ctx.api.listRunUsageEvents(caseId, runId, options)),
    renderItem: usageEntry,
    // A call is listed as reserved before it starts and updated in place when it settles.
    revisionOf: (event) => JSON.stringify(event),
  });

  const element: HTMLDetailsElement = h(
    'details',
    {
      class: 'usage-events',
      hidden: true,
      ontoggle: () => {
        if (element.open) void feed.refresh();
      },
    },
    h('summary', null, 'Every call this run made'),
    h('p', { class: 'hint' }, 'Each tool call and model call, whether it succeeded and what it cost. “Unknown” means it was not measured; it does not mean zero.'),
    feed.element,
  );

  return {
    element,
    update(run) {
      const next = run?.runId ?? null;
      element.hidden = next === null;
      if (next !== runId) {
        runId = next;
        signature = '';
        feed.reset();
      }
      const current = run === null ? '' : JSON.stringify([run.state, run.usage]);
      const changed = current !== signature;
      signature = current;
      if (element.open && runId !== null && changed) void feed.refresh();
    },
  };
}
