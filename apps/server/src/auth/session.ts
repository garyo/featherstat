import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DAY_MS } from '@featherstat/shared';
import {
  type AdminSessionRow,
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
// (or anything writing `Domain=` cookies) cannot shadow the admin session.
export const SESSION_COOKIE = '__Host-session';
export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_TTL_MS = 14 * DAY_MS;
/**
 * Viewer sessions live longer and SLIDE (auth.ts renews one that has burned
 * half its life): a viewer has no password to log back in with — their magic
 * link was single-use — so expiry means asking the admin for a new invite.
 * 90 days of inactivity is the honest cost of that reset.
 */
export const VIEWER_SESSION_TTL_MS = 90 * DAY_MS;

/** Users have a password to log back in with, so they share the admin's fixed TTL. */
export function sessionTtlOf(kind: 'admin' | 'viewer' | 'user'): number {
  return kind === 'viewer' ? VIEWER_SESSION_TTL_MS : SESSION_TTL_MS;
}

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

export function issueSession(
  db: Db,
  secret: Buffer,
  now: number,
  /** Defaults to an admin session; viewer logins (magic links) and user logins pass theirs. */
  principal:
    | { kind: 'admin' }
    | { kind: 'viewer'; viewerId: number }
    | { kind: 'user'; userId: number } = { kind: 'admin' },
): IssuedSession {
  const id = randomBytes(SESSION_ID_BYTES).toString('hex');
  const expiresAt = now + sessionTtlOf(principal.kind);
  withWriteTransaction(db, () => {
    deleteExpiredAdminSessions(db, now); // opportunistic sweep — no timer needed
    insertAdminSession(db, {
      id,
      created_at: now,
      expires_at: expiresAt,
      principal_kind: principal.kind,
      viewer_id: principal.kind === 'viewer' ? principal.viewerId : null,
      user_id: principal.kind === 'user' ? principal.userId : null,
    });
  });
  return {
    id,
    cookieValue: `${id}.${sign(secret, id)}`,
    csrfToken: csrfTokenFor(secret, id),
    expiresAt,
  };
}

/** Cookie → live session row, or undefined. Expired rows are deleted on sight. */
export function verifySessionCookie(
  db: Db,
  secret: Buffer,
  cookieValue: string | undefined,
  now: number,
): AdminSessionRow | undefined {
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
  return session;
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
