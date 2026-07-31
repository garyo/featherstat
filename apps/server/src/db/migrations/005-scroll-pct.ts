import type { Migration } from '../migrate.ts';

/**
 * Schema v5 — how far down the page the reader got.
 *
 * Time on page says a visitor stayed; it cannot say they read. This is the
 * companion figure: the native tracker's per-page high-water mark, 0–100,
 * riding the pings that already fly (docs/04 § 2).
 *
 * Nullable, and null means UNMEASURED rather than 0 — every row already stored,
 * every hit from the matomo.js shim, and every imported Matomo row has no
 * reading and never will. `query/dwell.ts` averages over the rows that have one
 * and counts them separately, the same way `measured_sessions` refuses to read
 * a missing measurement as a small one.
 *
 * No index, deliberately. The scroll aggregate reads rows the dwell query's
 * session scan has already touched, so an index buys the only query that reads
 * this column nothing, and would cost every insert a second B-tree — the same
 * reasoning migration 004 used in reverse.
 */
export const migration005: Migration = {
  version: 5,
  name: 'scroll-pct',
  sql: `
ALTER TABLE events ADD COLUMN scroll_pct INTEGER;
`,
};
