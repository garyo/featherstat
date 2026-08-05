import type { Migration } from '../migrate.ts';

/**
 * Traffic exclusion (docs/03 § Exclusions): hits from a configured address are
 * dropped at the door and counted, exactly as bot traffic is. A separate table
 * rather than a discriminator on `bot_drops` so the two reasons a hit vanished —
 * a crawler, or the operator's own browser — never have to be told apart after
 * the fact.
 *
 * The rules themselves live in a settings row, not here: they are the operator's
 * own addresses, and no visitor address is stored by any of this (invariant 3).
 */
export const migration102: Migration = {
  version: 102,
  name: 'excluded-drops',
  sql: `
CREATE TABLE excluded_drops (
  site_id    INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date)
);
`,
};
