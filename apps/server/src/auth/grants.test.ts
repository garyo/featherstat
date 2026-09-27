import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, T0 } from '../../test/rows.ts';
import {
  type Db,
  getMagicLink,
  insertApiToken,
  insertMagicLink,
  insertViewer,
  listApiTokens,
  listViewers,
  revokeViewer,
  withWriteTransaction,
} from '../db/index.ts';
import { dropSiteFromGrants } from './grants.ts';

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

function token(name: string, siteScope: string): void {
  insertApiToken(db, {
    name,
    token_hash: new Uint8Array(32).fill(name.charCodeAt(0)),
    site_scope: siteScope,
    created_at: T0,
  });
}

function scopesOf(rows: ReadonlyArray<{ site_scope: string; revoked_at: number | null }>) {
  return rows.map((row) => [row.site_scope, row.revoked_at]);
}

describe('dropSiteFromGrants', () => {
  it('narrows token scopes, revokes the ones it empties, and leaves the rest alone', () => {
    withWriteTransaction(db, () => {
      token('a', '[1,2]');
      token('b', '[2]');
      token('c', 'all');
      token('d', '[3]');
      token('e', 'not json'); // fails closed on read; nothing here widens it
      dropSiteFromGrants(db, 2, T0 + 1);
    });

    expect(scopesOf(listApiTokens(db))).toEqual([
      ['[1]', null],
      ['[]', T0 + 1],
      ['all', null],
      ['[3]', null],
      ['not json', null],
    ]);
  });

  it('narrows viewer scopes; an emptied viewer is revoked and its links expire', () => {
    const linkHash = new Uint8Array(32).fill(7);
    withWriteTransaction(db, () => {
      insertViewer(db, { email: 'both@example.com', site_scope: '[1,2]', created_at: T0 });
      const only = insertViewer(db, {
        email: 'only@example.com',
        site_scope: '[2]',
        created_at: T0,
      });
      const gone = insertViewer(db, {
        email: 'gone@example.com',
        site_scope: '[2]',
        created_at: T0,
      });
      revokeViewer(db, gone.id, T0);
      insertMagicLink(db, {
        token_hash: linkHash,
        viewer_id: only.id,
        user_id: null,
        purpose: 'viewer-login',
        created_at: T0,
        expires_at: T0 + 1_000_000,
      });
      dropSiteFromGrants(db, 2, T0 + 1);
    });

    expect(scopesOf(listViewers(db))).toEqual([
      ['[1]', null],
      ['[]', T0 + 1],
      // Already revoked: the scope still narrows, the revocation time stays.
      ['[]', T0],
    ]);
    expect(getMagicLink(db, linkHash)?.expires_at).toBe(T0 + 1);
  });
});
