import { describe, expect, it } from 'vitest';
import { openTestDb } from '../../test/rows.ts';
import { getAdminSession } from '../db/index.ts';
import {
  csrfTokenFor,
  ensureAuthSecret,
  issueSession,
  revokeSession,
  SESSION_TTL_MS,
  verifyCsrfToken,
  verifySessionCookie,
} from './session.ts';

const T0 = 1_700_000_000_000;

describe('auth secret', () => {
  it('is minted once and stable across reads', () => {
    const db = openTestDb();
    const first = ensureAuthSecret(db);
    expect(first).toHaveLength(32);
    expect(ensureAuthSecret(db).equals(first)).toBe(true);
    db.close();
  });
});

describe('admin sessions', () => {
  it('issues a session the cookie value verifies back to', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const issued = issueSession(db, secret, T0);
    expect(issued.id).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresAt).toBe(T0 + SESSION_TTL_MS);
    expect(verifySessionCookie(db, secret, issued.cookieValue, T0 + 1)).toBe(issued.id);
    db.close();
  });

  it('rejects a tampered signature without touching the database row', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const issued = issueSession(db, secret, T0);
    const signature = issued.cookieValue.split('.')[1] ?? '';
    const flipped = (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1);
    expect(verifySessionCookie(db, secret, `${issued.id}.${flipped}`, T0 + 1)).toBeUndefined();
    expect(getAdminSession(db, issued.id)).toBeDefined();
    db.close();
  });

  it('rejects a well-signed cookie whose session row is gone', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const issued = issueSession(db, secret, T0);
    revokeSession(db, issued.id);
    expect(verifySessionCookie(db, secret, issued.cookieValue, T0 + 1)).toBeUndefined();
    db.close();
  });

  it('expires after 14 days and deletes the row on sight', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const issued = issueSession(db, secret, T0);
    const lastValid = T0 + SESSION_TTL_MS - 1;
    expect(verifySessionCookie(db, secret, issued.cookieValue, lastValid)).toBe(issued.id);
    expect(
      verifySessionCookie(db, secret, issued.cookieValue, T0 + SESSION_TTL_MS),
    ).toBeUndefined();
    expect(getAdminSession(db, issued.id)).toBeUndefined();
    db.close();
  });

  it('sweeps other expired rows when a new session is issued', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const stale = issueSession(db, secret, T0);
    issueSession(db, secret, T0 + SESSION_TTL_MS + 1);
    expect(getAdminSession(db, stale.id)).toBeUndefined();
    db.close();
  });

  it('handles malformed cookie values as unauthenticated, never a crash', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    for (const garbage of [undefined, '', 'no-dot', '.sig-only', 'id.', 'a.b.c']) {
      expect(verifySessionCookie(db, secret, garbage, T0)).toBeUndefined();
    }
    db.close();
  });
});

describe('CSRF tokens', () => {
  it('binds the token to the session id', () => {
    const db = openTestDb();
    const secret = ensureAuthSecret(db);
    const token = csrfTokenFor(secret, 'session-a');
    expect(verifyCsrfToken(secret, 'session-a', token)).toBe(true);
    expect(verifyCsrfToken(secret, 'session-b', token)).toBe(false);
    expect(verifyCsrfToken(secret, 'session-a', undefined)).toBe(false);
    expect(verifyCsrfToken(secret, 'session-a', `${token}x`)).toBe(false);
    db.close();
  });
});
