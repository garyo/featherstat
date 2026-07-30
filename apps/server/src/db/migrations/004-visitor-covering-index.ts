import type { Migration } from '../migrate.ts';

/**
 * Schema v4 — the distinct-visitor count reads its answer out of the index.
 *
 * `visitors` is `COUNT(DISTINCT CASE WHEN type != 'ping' THEN visitor_id END)`,
 * and `ix_events_site_date (site_id, local_date, type)` carried every column of
 * it but the one being counted, so each matching row cost a table lookup.
 *
 * The new index is that one with `visitor_id` appended, so it REPLACES it rather
 * than sitting beside it: same prefix, same seeks, and every plan the narrow one
 * served the wide one serves as a covering scan instead. Keeping both would buy
 * nothing a query can see and cost every insert a second B-tree — and ingest
 * throughput is budgeted (docs/02).
 */
export const migration004: Migration = {
  version: 4,
  name: 'visitor-covering-index',
  sql: `
CREATE INDEX ix_events_site_date_visitor ON events (site_id, local_date, type, visitor_id);
DROP INDEX ix_events_site_date;
`,
};
