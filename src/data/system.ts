/** Cosmos DB adds `_rid`, `_self`, `_etag`, `_attachments` and `_ts`; they are never written back. */
export function stripSystemFields<T extends object>(doc: T): T {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_'))) as T;
}
