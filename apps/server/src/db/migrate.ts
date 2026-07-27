import type BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.ts';

export type Db = BetterSqlite3.Database;

export interface Migration {
  /** Strictly increasing across the migration list; also the `user_version` it leaves behind. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/** `PRAGMA user_version` mirrors the highest applied migration (docs/03). */
export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies pending migrations in order, each in its own transaction, and returns the
 * resulting schema version. Idempotent: already-applied versions are skipped.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = assertSequential(migrations);
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(
      `database schema is version ${current}, newer than this build knows (${latest}) — refusing to run`,
    );
  }

  db.exec(SCHEMA_MIGRATIONS_DDL);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[],
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
      // Not parameterizable; `version` is a validated integer from our own list.
      db.exec(`PRAGMA user_version = ${m.version}`);
    }).immediate();
  }

  return schemaVersion(db);
}

/** Returns the latest version in the list. */
function assertSequential(migrations: readonly Migration[]): number {
  let previous = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= previous) {
      throw new Error(
        `migration versions must be increasing integers; saw ${m.version} after ${previous}`,
      );
    }
    previous = m.version;
  }
  return previous;
}
