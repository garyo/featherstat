import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, getSetting, setSetting, withWriteTransaction } from '../db/index.ts';

/**
 * Nightly `VACUUM INTO` backup (docs/02 § Background jobs). Off until the
 * operator sets a directory in Settings → Data; then one dated copy per day,
 * pruned to the newest N.
 *
 * `VACUUM INTO` is the ONLY safe way to copy a live WAL database (docs/10) —
 * it writes a compacted, consistent snapshot from one read transaction. It is
 * deliberately run OUTSIDE `withWriteTransaction`: it is a read-side statement
 * (it never touches the source file), SQLite refuses VACUUM inside any open
 * transaction, and its read snapshot means concurrent ingest flushes commit
 * unbothered — the single-writer discipline (invariant 2) is about writes, and
 * this makes none. better-sqlite3 is synchronous, so the vacuum blocks the
 * process for its duration — acceptable at the target scale (a few hundred MB
 * copies in seconds, once a night); `db.backup()` is the incremental,
 * non-blocking upgrade path if that ever stops being true.
 */

/** Settings keys (docs/05 § Settings): directory absent = backups off. */
export const BACKUP_DIR_KEY = 'backup_dir';
export const BACKUP_KEEP_KEY = 'backup_keep';
export const DEFAULT_BACKUP_KEEP = 7;

/** Last successful run, persisted so a restart does not re-vacuum the same night. */
const BACKUP_LAST_RUN_KEY = 'backup_last_run';

const BACKUP_FILE = /^analytics-\d{4}-\d{2}-\d{2}\.db$/;

export interface BackupResult {
  /** No directory configured — nothing was examined. */
  skipped: boolean;
  /** The file this run wrote. */
  file?: string;
  /** Older copies removed by the keep-N prune. */
  pruned: string[];
}

export interface BackupOptions {
  now?: () => number;
}

export function backupLastRunAt(db: Db): number | undefined {
  const raw = getSetting(db, BACKUP_LAST_RUN_KEY);
  return raw === undefined ? undefined : Number(raw);
}

/** Copies to keep; the setting must be a positive integer to override the default. */
export function backupKeep(db: Db): number {
  const days = Number(getSetting(db, BACKUP_KEEP_KEY) ?? Number.NaN);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_BACKUP_KEEP;
}

export function runBackup(db: Db, options: BackupOptions = {}): BackupResult {
  const dir = getSetting(db, BACKUP_DIR_KEY);
  if (dir === undefined || dir === '') return { skipped: true, pruned: [] };

  const now = options.now?.() ?? Date.now();
  const name = `analytics-${new Date(now).toISOString().slice(0, 10)}.db`;
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  // A same-day re-run replaces its own copy: VACUUM INTO refuses an existing target.
  if (existsSync(file)) rmSync(file);
  db.prepare('VACUUM INTO ?').run(file);

  const pruned = readdirSync(dir)
    .filter((entry) => BACKUP_FILE.test(entry))
    .sort()
    .reverse()
    .slice(backupKeep(db));
  for (const entry of pruned) rmSync(join(dir, entry));

  withWriteTransaction(db, () => setSetting(db, BACKUP_LAST_RUN_KEY, String(now)));
  return { skipped: false, file, pruned };
}
