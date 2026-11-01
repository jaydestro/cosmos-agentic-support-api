/** What a list already shows, as far as deciding what a page changes. */
export interface ShownEntries {
  /** The highest `seq` on screen, or null while nothing is. */
  readonly newest: number | null;
  /** What each shown entry was drawn from, by `seq`. Empty for a list whose entries never change. */
  readonly revisions: ReadonlyMap<number, string>;
}

/** What reading a page changes in a list that is already on screen. */
export interface FeedPlan<T> {
  /** Entries that come after everything shown, in the order they were read. */
  readonly fresh: readonly T[];
  /** Entries already shown whose content has changed since they were drawn. */
  readonly changed: readonly T[];
}

/**
 * Entries are told apart by `seq`. A list whose entries never change once recorded passes no `revisionOf` and only
 * gains entries. A list whose entries are updated in place (a call that was in flight and has since settled) passes
 * one, and also learns which entries it must draw again. An entry below the newest one that was never shown is left
 * out: the service numbers entries as it records them, so a gap does not fill in later.
 */
export function planFeedUpdate<T extends { readonly seq: number }>(items: readonly T[], shown: ShownEntries, revisionOf?: (item: T) => string): FeedPlan<T> {
  const fresh: T[] = [];
  const changed: T[] = [];
  for (const item of items) {
    if (shown.newest === null || item.seq > shown.newest) {
      fresh.push(item);
    } else if (revisionOf !== undefined) {
      const drawn = shown.revisions.get(item.seq);
      if (drawn !== undefined && drawn !== revisionOf(item)) changed.push(item);
    }
  }
  return { fresh, changed };
}
