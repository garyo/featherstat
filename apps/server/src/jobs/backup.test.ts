import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb } from '../../test/rows.ts';
import { type Db, insertEvents, setSetting, withWriteTransaction } from '../db/index.ts';
import {
  BACKUP_DIR_KEY,
  BACKUP_KEEP_KEY,
  backupKeep,
  backupLastRunAt,
  DEFAULT_BACKUP_KEEP,
  runBackup,
} from './backup.ts';

const NOW = Date.UTC(2026, 7, 1, 3);

let db: Db;
let dir: string;

beforeEach(() => {
  db = openTestDb();
  dir = mkdtempSync(join(tmpdir(), 'featherstat-backup-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function configure(keep?: number): void {
  withWriteTransaction(db, () => {
    setSetting(db, BACKUP_DIR_KEY, dir);
    if (keep !== undefined) setSetting(db, BACKUP_KEEP_KEY, String(keep));
  });
}

describe('runBackup', () => {
  it('is off by default — no directory, nothing written, nothing recorded', () => {
    expect(runBackup(db, { now: () => NOW })).toEqual({ skipped: true, pruned: [] });
    expect(backupLastRunAt(db)).toBeUndefined();
  });

  it('writes a dated, openable copy and records the run', () => {
    withWriteTransaction(db, () => insertEvents(db, [event(), event({ seq: 2 })]));
    configure();

    const result = runBackup(db, { now: () => NOW });

    expect(result.skipped).toBe(false);
    expect(result.file).toBe(join(dir, 'analytics-2026-08-01.db'));
    expect(backupLastRunAt(db)).toBe(NOW);

    // The copy is a real database with the same rows — not a torn `cp` of a WAL file.
    const copy = new BetterSqlite3(result.file as string, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    copy.close();
  });

  it('replaces its own copy on a same-day re-run', () => {
    configure();
    runBackup(db, { now: () => NOW });
    withWriteTransaction(db, () => insertEvents(db, [event()]));

    const again = runBackup(db, { now: () => NOW });

    const copy = new BetterSqlite3(again.file as string, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(1);
    copy.close();
    expect(readdirSync(dir)).toEqual(['analytics-2026-08-01.db']);
  });

  it('prunes to the newest N copies and leaves foreign files alone', () => {
    configure(2);
    for (const day of ['2026-07-28', '2026-07-29', '2026-07-30']) {
      writeFileSync(join(dir, `analytics-${day}.db`), 'old copy');
    }
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');

    const result = runBackup(db, { now: () => NOW });

    expect(result.pruned).toEqual(['analytics-2026-07-29.db', 'analytics-2026-07-28.db']);
    expect(readdirSync(dir).sort()).toEqual([
      'analytics-2026-07-30.db',
      'analytics-2026-08-01.db',
      'notes.txt',
    ]);
  });
});

describe('a backup that fails', () => {
  it('keeps the last good copy, leaves no partial file and prunes nothing', () => {
    configure(1);
    writeFileSync(join(dir, 'analytics-2026-07-31.db'), 'yesterday');
    writeFileSync(join(dir, 'analytics-2026-08-01.db'), 'this morning');
    const prepare = db.prepare.bind(db);
    const failing = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!sql.startsWith('VACUUM')) return prepare(sql);
      return {
        run: (target: string) => {
          writeFileSync(target, 'torn'); // what a disk-full VACUUM leaves behind
          throw new Error('disk full');
        },
      } as unknown as ReturnType<Db['prepare']>;
    });

    expect(() => runBackup(db, { now: () => NOW })).toThrow('disk full');
    failing.mockRestore();

    expect(readdirSync(dir).sort()).toEqual(['analytics-2026-07-31.db', 'analytics-2026-08-01.db']);
    expect(readFileSync(join(dir, 'analytics-2026-08-01.db'), 'utf8')).toBe('this morning');
    expect(backupLastRunAt(db)).toBeUndefined();
  });
});

describe('backupKeep', () => {
  it('defaults to 7 and ignores unusable values', () => {
    expect(backupKeep(db)).toBe(DEFAULT_BACKUP_KEEP);
    withWriteTransaction(db, () => setSetting(db, BACKUP_KEEP_KEY, 'many'));
    expect(backupKeep(db)).toBe(DEFAULT_BACKUP_KEEP);
    withWriteTransaction(db, () => setSetting(db, BACKUP_KEEP_KEY, '3'));
    expect(backupKeep(db)).toBe(3);
  });
});
