import type { Migration } from '../migrate.ts';

/**
 * Multi-user (docs/04 § 5): password-holding accounts that each own a set of
 * sites and manage them. Ownership is a join table rather than a column on
 * `sites`, which keeps the public SQLite contract (docs/09) untouched and
 * leaves room for shared sites. The instance admin stays the `auth.password`
 * settings row — this migration touches no existing auth state, so an upgraded
 * deployment that never creates a user behaves identically.
 *
 * `magic_links` is rebuilt (its rows are single-use, 7-day tokens — nothing of
 * value to preserve) so a link can belong to either a viewer or a user: viewer
 * links log in, user links claim an account by setting its first password.
 */
export const migration103: Migration = {
  version: 103,
  name: 'users',
  sql: `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                    -- scrypt string; NULL until the invite is claimed
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER                  -- soft revoke; live sessions die at the auth gate
);

CREATE TABLE user_sites (
  user_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, site_id)
) WITHOUT ROWID;

CREATE INDEX ix_user_sites_site ON user_sites (site_id);

ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER;
ALTER TABLE viewers        ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE api_tokens     ADD COLUMN created_by_user_id INTEGER;

CREATE TABLE magic_links_new (
  token_hash BLOB PRIMARY KEY,            -- sha256 of the raw link token
  viewer_id  INTEGER,
  user_id    INTEGER,
  purpose    TEXT NOT NULL DEFAULT 'viewer-login',  -- 'viewer-login' | 'user-invite'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,                     -- single use
  CHECK ((viewer_id IS NULL) <> (user_id IS NULL))
);
INSERT INTO magic_links_new (token_hash, viewer_id, created_at, expires_at, used_at)
  SELECT token_hash, viewer_id, created_at, expires_at, used_at FROM magic_links;
DROP TABLE magic_links;
ALTER TABLE magic_links_new RENAME TO magic_links;
`,
};
