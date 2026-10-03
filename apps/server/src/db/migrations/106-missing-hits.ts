import type { Migration } from '../migrate.ts';

/**
 * Not-found hits (docs/03 § Not-found hits): a page view of a page that does not
 * exist is recorded apart from traffic. It belongs to no visit — scanners and
 * dead inbound links are most of them — so it has no visitor or session id, and
 * nothing that counts traffic reads this table.
 *
 * `missing_hits` keeps what finds the broken link: the path asked for and the
 * page that linked to it. `missing_daily` counts every not-found hit per site
 * and local day, stored or not: past `MISSING_HITS_PER_SITE_DAY` a scanner's
 * sweep is counted rather than stored.
 *
 * The settings row is the enqueue protocol of `jobs/missing-backfill.ts` (a
 * watermark, `0` meaning "start at the beginning"): the one-time move of
 * not-found page views already recorded as traffic drains at the next boot.
 * On a fresh database that is one empty scan.
 */
export const migration106: Migration = {
  version: 106,
  name: 'missing-hits',
  sql: `
CREATE TABLE missing_hits (
  id          INTEGER PRIMARY KEY,        -- rowid; low bits of the data-version with events.id
  site_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,           -- UTC unix ms
  local_date  TEXT NOT NULL,              -- 'YYYY-MM-DD' in site tz, computed at ingest
  local_hour  INTEGER NOT NULL,           -- 0-23 in site tz
  path        TEXT,                       -- the path asked for; NULL when the page did not say
  ref_type    TEXT NOT NULL,              -- 'direct'|'search'|'social'|'referral'|'internal'
  ref_domain  TEXT,
  ref_path    TEXT,                       -- the referring page's pathname, query dropped
  device_type TEXT,
  country     TEXT
);

CREATE INDEX ix_missing_hits_site_date ON missing_hits (site_id, local_date);

CREATE TABLE missing_daily (
  site_id    INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, local_date)
);

INSERT INTO settings (key, value) VALUES ('missing_backfill:events', '0')
ON CONFLICT (key) DO NOTHING;
`,
};
