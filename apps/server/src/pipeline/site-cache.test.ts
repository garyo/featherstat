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

describe('SiteCache.resolve (docs/04 § 2)', () => {
  it('names a site by its id or by any domain it lists, regardless of case', () => {
    const cache = seeded();
    withWriteTransaction(db, () =>
      updateSite(db, SITE.id, { domains: ['pcons.org', 'www.pcons.org'] }),
    );
    expect(cache.resolve(SITE.id)?.id).toBe(SITE.id);
    expect(cache.resolve('pcons.org')?.id).toBe(SITE.id);
    expect(cache.resolve('WWW.Pcons.org')?.id).toBe(SITE.id);
    expect(cache.resolve('docs.pcons.org')).toBeUndefined();
  });

  it('follows a domain edit, and a domain freed by a deleted site', () => {
    const cache = seeded();
    expect(cache.resolve('pcons.org')?.id).toBe(SITE.id);
    withWriteTransaction(db, () => updateSite(db, SITE.id, { domains: ['pcons.dev'] }));
    expect(cache.resolve('pcons.org')).toBeUndefined();
    expect(cache.resolve('pcons.dev')?.id).toBe(SITE.id);
    withWriteTransaction(db, () => tombstoneSite(db, SITE.id, Date.now()));
    expect(cache.resolve('pcons.dev')).toBeUndefined();
  });

  it('re-reads who owns which host once a domain moves', () => {
    const cache = seeded();
    expect(cache.owners().ownerOf('docs.pcons.org')).toBe(SITE.id);
    withWriteTransaction(db, () =>
      createSite(db, { id: 4, name: 'docs', domains: ['docs.pcons.org'], timezone: 'UTC' }),
    );
    expect(cache.owners().ownerOf('docs.pcons.org')).toBe(4);
    expect(cache.owners().ownerOf('www.pcons.org')).toBe(SITE.id);
  });

  it('gives a domain two sites list (an import predating the rule) to the older one', () => {
    const cache = seeded();
    withWriteTransaction(db, () => createSite(db, { ...SITE, id: 2, name: 'older' }));
    expect(cache.resolve('pcons.org')?.id).toBe(2);
  });
});
