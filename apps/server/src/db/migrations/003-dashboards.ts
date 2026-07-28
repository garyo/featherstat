import type { Migration } from '../migrate.ts';

/** Schema v3 — dashboard persistence + share links (docs/04 § 5, docs/05 § Widgets). */
export const migration003: Migration = {
  version: 3,
  name: 'dashboards',
  sql: `
CREATE TABLE dashboards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,              -- denormalized from layout.name for listing
  site_scope  TEXT NOT NULL,              -- 'all' or a site id, from layout.site
  layout      TEXT NOT NULL,              -- Dashboard JSON, DashboardSchema-validated on write
  updated_at  INTEGER NOT NULL            -- UTC unix ms
);

-- Read-only share links (docs/02 § Security posture): the raw token is returned
-- once at mint time and only its sha256 is stored — a leaked DB mints nothing.
CREATE TABLE share_tokens (
  token_hash   BLOB PRIMARY KEY,          -- sha256 of the raw token
  dashboard_id INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,          -- UTC unix ms
  revoked_at   INTEGER                    -- NULL while live
);

CREATE INDEX ix_share_tokens_dashboard ON share_tokens (dashboard_id);
`,
};
