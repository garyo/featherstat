import type { Migration } from '../migrate.ts';

/** Schema v2 — admin sessions (docs/02 § Security posture, docs/04 § 5). */
export const migration002: Migration = {
  version: 2,
  name: 'admin-sessions',
  sql: `
CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,           -- 32 random bytes, hex
  created_at  INTEGER NOT NULL,           -- UTC unix ms
  expires_at  INTEGER NOT NULL
);

CREATE INDEX ix_admin_sessions_expiry ON admin_sessions (expires_at);
`,
};
