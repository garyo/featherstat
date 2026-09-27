import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSite,
  type Db,
  openDb,
  tombstoneSite,
  updateSite,
  withWriteTransaction,
} from '../db/index.ts';
import { SiteCache } from './site-cache.ts';

const SITE = { id: 3, name: 'pcons', domains: ['pcons.org'], timezone: 'America/New_York' };

let db: Db;

afterEach(() => {
  db?.close();
});

function seeded(): SiteCache {
  db = openDb(':memory:');
  withWriteTransaction(db, () => createSite(db, SITE));
  return new SiteCache(db);
}

/** A change the helpers never saw, on the same connection: only a cache would miss it. */
function renameBehindTheHelpers(name: string): void {
  withWriteTransaction(db, () => {
    db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, SITE.id);
  });
}

describe('SiteCache', () => {
  it('answers a known site from memory once it has read it', () => {
    const cache = seeded();
    expect(cache.get(SITE.id)?.name).toBe('pcons');
    renameBehindTheHelpers('renamed');
    expect(cache.get(SITE.id)?.name).toBe('pcons');
  });

  it('forgets everything when a site is edited through the helper', () => {
    const cache = seeded();
    cache.get(SITE.id);
    withWriteTransaction(db, () => updateSite(db, SITE.id, { timezone: 'Asia/Tokyo' }));
    expect(cache.get(SITE.id)?.timezone).toBe('Asia/Tokyo');
  });

  it('sees a site created after an unknown id was asked for', () => {
    const cache = seeded();
    expect(cache.get(9)).toBeUndefined();
    withWriteTransaction(db, () => createSite(db, { ...SITE, id: 9, name: 'new' }));
    expect(cache.get(9)?.name).toBe('new');
  });

  // Deleting a site must stop its beacons at once, exactly like an unknown id.
  it('drops a tombstoned site immediately', () => {
    const cache = seeded();
    cache.get(SITE.id);
    withWriteTransaction(db, () => tombstoneSite(db, SITE.id, Date.now()));
    expect(cache.get(SITE.id)).toBeUndefined();
  });

  it('forgets a rolled-back edit rather than keeping what never committed', () => {
    const cache = seeded();
    cache.get(SITE.id);
    expect(() =>
      withWriteTransaction(db, () => {
        updateSite(db, SITE.id, { name: 'doomed' });
        expect(cache.get(SITE.id)?.name).toBe('doomed'); // inside, the edit is real
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(cache.get(SITE.id)?.name).toBe('pcons');
  });

  // The Matomo importer creates sites from its own process while the server runs.
  it('notices a commit from another connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-cache-'));
    const other = (): Db => openDb(join(dir, 'a.db'));
    try {
      db = other();
      const cache = new SiteCache(db);
      expect(cache.get(SITE.id)).toBeUndefined();
      const importer = other();
      withWriteTransaction(importer, () => createSite(importer, SITE));
      expect(cache.get(SITE.id)?.name).toBe('pcons');
      withWriteTransaction(importer, () => updateSite(importer, SITE.id, { name: 'moved' }));
      expect(cache.get(SITE.id)?.name).toBe('moved');
      importer.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
