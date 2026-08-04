import type { Migration } from '../migrate.ts';

/**
 * Referrer canonicalization (docs/03 § Attribution): `ref_domain` becomes the
 * canonical domain and the received host moves to `ref_domain_raw`, kept only
 * when canonicalization changed it — the `utm_*` / `utm_*_raw` pair's shape,
 * on both tables that carry attribution.
 *
 * The two settings rows ARE the enqueue protocol of `jobs/referrer-backfill.ts`
 * (a per-table watermark, `0` meaning "start at the beginning"), so upgrading
 * schedules the one-time rewrite of stored history and the job drains it at the
 * next boot. On a fresh database that is one empty scan.
 */
export const migration101: Migration = {
  version: 101,
  name: 'ref-domain-raw',
  sql: `
ALTER TABLE events   ADD COLUMN ref_domain_raw TEXT;
ALTER TABLE sessions ADD COLUMN ref_domain_raw TEXT;

INSERT INTO settings (key, value) VALUES
  ('referrer_backfill:events', '0'),
  ('referrer_backfill:sessions', '0')
ON CONFLICT (key) DO NOTHING;
`,
};
