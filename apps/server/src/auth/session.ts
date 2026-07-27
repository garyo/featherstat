import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DAY_MS } from '@analytics/shared';
import {
  type Db,
  deleteAdminSession,
  deleteExpiredAdminSessions,
  getAdminSession,
  getSetting,
  insertAdminSession,
  setSetting,
  withWriteTransaction,
} from '../db/index.ts';

/**
 * Admin sessions (docs/02 § Security posture): a random 32-byte id in
 * `admin_sessions`, carried by an HMAC-signed HttpOnly cookie. The signature
 * makes an unauthenticated request cost one HMAC instead of one DB lookup, and
 * ties cookies to this database — a copied cookie is worthless elsewhere.
 */

// `__Host-` pins the cookies to this host, Secure, Path=/ — a sibling subdomain
// (or anything writing `Domain=` cookies) can no longer shadow the admin session.
export const SESSION_COOKIE = '__Host-session';
export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_TTL_MS = 14 * DAY_MS;

const SESSION_ID_BYTES = 32;
const SECRET_SETTING = 'auth.secret';

/** Loads (or mints, first boot) the HMAC key for cookie and CSRF signatures. */
export function ensureAuthSecret(db: Db): Buffer {
  const existing = getSetting(db, SECRET_SETTING);
  if (existing !== undefined) return Buffer.from(existing, 'hex');
  const secret = randomBytes(32);
  withWriteTransaction(db, () => setSetting(db, SECRET_SETTING, secret.toString('hex')));
  return secret;
}

export interface IssuedSession {
  id: string;
  /** `id.signature` — the session cookie's value. */
  cookieValue: string;
  csrfToken: string;
  expiresAt: number;
}

export function issueSession(db: Db, secret: Buffer, now: number): IssuedSession {
  const id = randomBytes(SESSION_ID_BYTES).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;
  withWriteTransaction(db, () => {
    deleteExpiredAdminSessions(db, now); // opportunistic sweep — no timer needed
    insertAdminSession(db, { id, created_at: now, expires_at: expiresAt });
  });
  return {
    id,
    cookieValue: `${id}.${sign(secret, id)}`,
    csrfToken: csrfTokenFor(secret, id),
    expiresAt,
  };
}

/** Cookie → live session id, or undefined. Expired rows are deleted on sight. */
export function verifySessionCookie(
  db: Db,
  secret: Buffer,
  cookieValue: string | undefined,
  now: number,
): string | undefined {
  if (cookieValue === undefined) return undefined;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const id = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!constantTimeEquals(signature, sign(secret, id))) return undefined;
  const session = getAdminSession(db, id);
  if (session === undefined) return undefined;
  if (session.expires_at <= now) {
    withWriteTransaction(db, () => deleteAdminSession(db, id));
    return undefined;
  }
  return id;
}

export function revokeSession(db: Db, id: string): void {
  withWriteTransaction(db, () => deleteAdminSession(db, id));
}

/**
 * The double-submit CSRF token: derived from the session id, so the readable
 * `csrf` cookie and the `x-csrf-token` header must both name the session the
 * HttpOnly cookie carries — an attacker-planted cookie pair verifies false.
 */
export function csrfTokenFor(secret: Buffer, sessionId: string): string {
  return sign(secret, `csrf.${sessionId}`);
}

export function verifyCsrfToken(
  secret: Buffer,
  sessionId: string,
  token: string | undefined,
): boolean {
  if (token === undefined) return false;
  return constantTimeEquals(token, csrfTokenFor(secret, sessionId));
}

function sign(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
