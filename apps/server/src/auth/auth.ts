import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type Db, getSetting, setSetting, withWriteTransaction } from '../db/index.ts';
import { hashPassword } from './password.ts';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenFor,
  ensureAuthSecret,
  type IssuedSession,
  issueSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyCsrfToken,
  verifySessionCookie,
} from './session.ts';

/**
 * The auth spine (docs/02 § Security posture): one admin password, DB-backed
 * sessions, double-submit CSRF. `gate` protects reads, `csrfGuard` additionally
 * protects mutations; the admin routes (routes/admin.ts) drive the state.
 */

const PASSWORD_SETTING = 'auth.password';
/** The session id `gate` grants when auth is disabled for local dev. */
export const DEV_SESSION_ID = 'dev';

export interface AuthOptions {
  /** Default: env `AUTH_DISABLED` is `1`/`true`. Only honored under a dev/test NODE_ENV. */
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** First-run setup token override for tests; defaults to a random one, logged once. */
  setupToken?: string;
  log?: (line: string) => void;
}

/** Hono context variables the gate provides to everything behind it. */
export type AuthVariables = { sessionId: string };
export type AuthEnv = { Variables: AuthVariables };

export interface Auth {
  readonly disabled: boolean;
  /** 401s anything without a live session; sets `sessionId` for handlers behind it. */
  readonly gate: MiddlewareHandler<AuthEnv>;
  /** 403s mutations whose `x-csrf-token` header does not name the gated session. */
  readonly csrfGuard: MiddlewareHandler<AuthEnv>;
  now(): number;
  hasPassword(): boolean;
  /** The stored scrypt string, for verification; undefined until first-run setup. */
  passwordHash(): string | undefined;
  /** True only while no password exists AND the presented token matches the logged one. */
  verifySetupToken(token: string): boolean;
  setPassword(password: string): Promise<void>;
  login(c: Context): IssuedSession;
  logout(c: Context, sessionId: string): void;
  csrfTokenOf(sessionId: string): string;
  sessionOf(c: Context): string | undefined;
}

export function createAuth(db: Db, options: AuthOptions = {}): Auth {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const disabled = options.disabled ?? (env.AUTH_DISABLED === '1' || env.AUTH_DISABLED === 'true');
  // Positive opt-in only: a stray AUTH_DISABLED in a deploy env (NODE_ENV unset
  // on bare metal is common) must fail loudly, never silently serve everything.
  if (disabled && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error(
      'AUTH_DISABLED is a local-dev bypass; it requires NODE_ENV=development (or test)',
    );
  }
  if (disabled) log('auth DISABLED (AUTH_DISABLED) — every dashboard request is open; dev only');
  const now = options.now ?? Date.now;
  const secret = ensureAuthSecret(db);

  // First-run claim protection: setup requires this token, printed to the
  // server log — whoever can read the console owns the instance, nobody else.
  let setupToken: string | undefined;
  if (!disabled && getSetting(db, PASSWORD_SETTING) === undefined) {
    setupToken = options.setupToken ?? randomBytes(16).toString('hex');
    if (options.setupToken === undefined) {
      log(`first-run setup token: ${setupToken}  (enter it on the setup screen)`);
    }
  }

  const sessionOf = (c: Context): string | undefined => {
    if (disabled) return DEV_SESSION_ID;
    return verifySessionCookie(db, secret, getCookie(c, SESSION_COOKIE), now());
  };

  const gate: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const sessionId = sessionOf(c);
    if (sessionId === undefined) return c.json({ error: 'unauthorized' }, 401);
    c.set('sessionId', sessionId);
    await next();
  };

  const csrfGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      return next();
    }
    if (!disabled) {
      const sessionId = c.get('sessionId');
      if (!verifyCsrfToken(secret, sessionId, c.req.header(CSRF_HEADER))) {
        return c.json({ error: 'missing or invalid CSRF token' }, 403);
      }
    }
    await next();
  };

  return {
    disabled,
    gate,
    csrfGuard,
    now,
    hasPassword: () => getSetting(db, PASSWORD_SETTING) !== undefined,
    passwordHash: () => getSetting(db, PASSWORD_SETTING),
    verifySetupToken(token) {
      if (setupToken === undefined) return false;
      const presented = Buffer.from(token);
      const expected = Buffer.from(setupToken);
      return presented.length === expected.length && timingSafeEqual(presented, expected);
    },
    async setPassword(password) {
      const hash = await hashPassword(password);
      withWriteTransaction(db, () => setSetting(db, PASSWORD_SETTING, hash));
      setupToken = undefined; // consumed — the window closes with the first password
    },
    login(c) {
      const issued = issueSession(db, secret, now());
      const maxAge = Math.floor(SESSION_TTL_MS / 1000);
      const base = { path: '/', secure: true, sameSite: 'Lax', maxAge } as const;
      setCookie(c, SESSION_COOKIE, issued.cookieValue, { ...base, httpOnly: true });
      // Readable on purpose: the double-submit copy the client echoes as a header.
      setCookie(c, CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false });
      return issued;
    },
    logout(c, sessionId) {
      revokeSession(db, sessionId);
      // `__Host-` deletion must repeat the exact attributes the cookie was set with.
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
      deleteCookie(c, CSRF_COOKIE, { path: '/', secure: true });
    },
    csrfTokenOf: (sessionId) => csrfTokenFor(secret, sessionId),
    sessionOf,
  };
}
