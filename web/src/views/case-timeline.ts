import { h } from '../dom.ts';
import { actorText, timelineLabel } from '../format.ts';
import type { TimelineItem } from '../types.ts';
import { panel, timeText } from './common.ts';
import type { ViewContext } from './context.ts';
import { createFeed } from './feed.ts';

const PAGE_SIZE = 10;

function dataValue(value: string | number | boolean | null): string {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** One entry. The data values can include text a person typed, so they only ever go in as text. */
export function timelineEntry(item: TimelineItem, principalId: string): HTMLLIElement {
  const data = Object.entries(item.data ?? {});
  return h(
    'li',
    { class: 'timeline-item' },
    h('div', { class: 'timeline-head' }, h('span', { class: 'timeline-seq' }, `#${String(item.seq)}`), ' ', h('strong', null, timelineLabel(item.kind)), ' ', timeText(item.at)),
    h('p', { class: 'timeline-by' }, `By ${actorText(item.actor, principalId).toLowerCase()}`),
    h('p', { class: 'timeline-summary' }, item.summary),
    data.length === 0
      ? null
      : h(
          'dl',
          { class: 'timeline-data' },
          data.map(([key, value]) => h('div', null, h('dt', null, key), h('dd', null, dataValue(value)))),
        ),
  );
}

export interface TimelineView {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
}

/** The case's timeline, oldest first, ten entries at a time. */
export function mountTimeline(ctx: ViewContext, caseId: string): TimelineView {
  const principalId = ctx.session.principal.principalId;
  const feed = createFeed<TimelineItem>({
    ctx,
    pageSize: PAGE_SIZE,
    noun: { one: 'entry', many: 'entries' },
    emptyText: 'Nothing has been recorded for this case yet.',
    loadingText: 'Loading the timeline…',
    fetchPage: (options) => ctx.api.getCaseTimeline(caseId, options),
    renderItem: (item) => timelineEntry(item, principalId),
  });
  return {
    element: panel('Timeline', h('p', { class: 'hint' }, 'What happened to this case, oldest first. It is an operating record, not a tamper-proof audit trail.'), feed.element),
    refresh: () => feed.refresh(),
  };
}
