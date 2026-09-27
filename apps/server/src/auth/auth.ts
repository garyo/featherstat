import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  type AdminSessionRow,
  type ApiTokenRow,
  type Db,
  extendAdminSession,
  getAdminSession,
  getApiToken,
  getApiTokenByHash,
  getSetting,
  getUser,
  getViewer,
  listUserSites,
  setSetting,
  touchApiToken,
  withWriteTransaction,
} from '../db/index.ts';
import { bearerCredential } from './bearer.ts';
import { hashPassword } from './password.ts';
import { isManager, type Principal, parseSiteScope } from './principal.ts';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenFor,
  ensureAuthSecret,
  type IssuedSession,
  issueSession,
  revokeSession,
  SESSION_COOKIE,
  sessionTtlOf,
  VIEWER_SESSION_TTL_MS,
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
const DEV_SESSION_ID = 'dev';

export interface AuthOptions {
  /** Default: env `AUTH_DISABLED` is `1`/`true`. Only honored under a dev/test NODE_ENV. */
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** First-run setup token override for tests; defaults to a random one, logged once. */
  setupToken?: string;
  log?: (line: string) => void;
}

/**
 * Hono context variables the gate provides to everything behind it.
 * `principal` is always set; `sessionId` only for cookie principals (admin,
 * viewer) — token requests carry no session, and the only readers of
 * `sessionId` (logout, password change, rate keys) sit behind `requireAdmin`
 * or fall back to another key.
 */
export type AuthVariables = { sessionId: string; principal: Principal };
export type AuthEnv = { Variables: AuthVariables };

/** The credential of a `Bearer` header: `fs_<43 base64url>`, shape-checked
 * before any hash. Case-sensitive — the scheme before it is not (bearer.ts). */
const TOKEN_SHAPE = /^fs_[A-Za-z0-9_-]{43}$/;
/** last_used_at is a coarse audit column, written at most this often. */
const TOKEN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface Auth {
  readonly disabled: boolean;
  /** 401s anything without a live principal; sets `principal` for handlers behind it. */
  readonly gate: MiddlewareHandler<AuthEnv>;
  /** 403s mutations whose `x-csrf-token` header does not name the gated session. */
  readonly csrfGuard: MiddlewareHandler<AuthEnv>;
  /** 403s everything but the admin — the write surface's second wall. */
  readonly requireAdmin: MiddlewareHandler<AuthEnv>;
  /** 403s everything but a manager (admin or user) — the wall on routes a
   * user may hold, whose handlers then check `canManageSite` per object. */
  readonly requireManager: MiddlewareHandler<AuthEnv>;
  now(): number;
  hasPassword(): boolean;
  /** The stored scrypt string, for verification; undefined until first-run setup. */
  passwordHash(): string | undefined;
  /** True only while no password exists AND the presented token matches the logged one. */
  verifySetupToken(token: string): boolean;
  setPassword(password: string): Promise<void>;
  login(c: Context, principal?: SessionPrincipal): IssuedSession;
  logout(c: Context, sessionId: string): void;
  csrfTokenOf(sessionId: string): string;
  sessionOf(c: Context): string | undefined;
  /** The request's cookie principal, or undefined — for the public `me` route,
   * which answers before the gate and needs the kind, not just the id. */
  cookiePrincipal(c: Context): Principal | undefined;
  /**
   * The principal the gate resolved earlier, re-read as it stands now: its
   * current scope, or undefined once its session, token, user or viewer is
   * gone. A response that outlives its request (the realtime stream) asks
   * this to learn of a revocation the gate would have caught.
   */
  refresh(principal: Principal): Principal | undefined;
}

/** What a session can be issued as — the magic-link claim passes the viewer
 * form, the user login and invite claim the user form. */
type SessionPrincipal =
  | { kind: 'admin' }
  | { kind: 'viewer'; viewerId: number }
  | { kind: 'user'; userId: number };

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
    return verifySessionCookie(db, secret, getCookie(c, SESSION_COOKIE), now())?.id;
  };

  /** `Authorization: Bearer` → token principal, or undefined. */
  const tokenPrincipalOf = (c: Context): Principal | undefined => {
    const credential = bearerCredential(c.req.header('authorization'));
    if (credential === undefined || !TOKEN_SHAPE.test(credential)) return undefined;
    const hash = createHash('sha256').update(credential).digest();
    const row = getApiTokenByHash(db, hash);
    const principal = tokenPrincipal(row);
    if (principal === undefined || row === undefined) return undefined;
    if (row.last_used_at === null || now() - row.last_used_at > TOKEN_TOUCH_INTERVAL_MS) {
      withWriteTransaction(db, () => touchApiToken(db, row.id, now()));
    }
    return principal;
  };

  /** A token row → principal, or undefined once revoked. */
  const tokenPrincipal = (row: ApiTokenRow | undefined): Principal | undefined =>
    row === undefined || row.revoked_at !== null
      ? undefined
      : { kind: 'token', tokenId: row.id, sites: parseSiteScope(row.site_scope) };

  /** Session row → principal; a session whose viewer was revoked or whose
   * user was disabled dies here. */
  const sessionPrincipal = (session: AdminSessionRow): Principal | undefined => {
    if (session.principal_kind === 'admin') return { kind: 'admin', sessionId: session.id };
    if (session.principal_kind === 'user' && session.user_id !== null) {
      const user = getUser(db, session.user_id);
      if (user === undefined || user.disabled_at !== null) return undefined;
      return {
        kind: 'user',
        sessionId: session.id,
        userId: user.id,
        sites: new Set(listUserSites(db, user.id)),
      };
    }
    if (session.principal_kind === 'viewer' && session.viewer_id !== null) {
      const viewer = getViewer(db, session.viewer_id);
      if (viewer === undefined || viewer.revoked_at !== null) return undefined;
      return {
        kind: 'viewer',
        sessionId: session.id,
        viewerId: viewer.id,
        sites: parseSiteScope(viewer.site_scope),
      };
    }
    return undefined;
  };

  /** The request's cookie → principal. Rows are re-read on every request, so
   * revocation reaches live sessions at the gate — and open realtime streams
   * on their next tick, through `refresh`. */
  const cookiePrincipalOf = (c: Context): Principal | undefined => {
    const session = verifySessionCookie(db, secret, getCookie(c, SESSION_COOKIE), now());
    if (session === undefined) return undefined;
    const principal = sessionPrincipal(session);
    // Sliding TTL: a viewer cannot log back in (their magic link was single
    // use), so an ACTIVE viewer's session renews itself once it has burned
    // half its life — at most one write per half-TTL, not one per request.
    if (principal?.kind === 'viewer' && session.expires_at - now() < VIEWER_SESSION_TTL_MS / 2) {
      withWriteTransaction(db, () =>
        extendAdminSession(db, session.id, now() + VIEWER_SESSION_TTL_MS),
      );
    }
    return principal;
  };

  const gate: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (disabled) {
      c.set('sessionId', DEV_SESSION_ID);
      c.set('principal', { kind: 'admin', sessionId: DEV_SESSION_ID });
      return next();
    }
    // A presented Bearer header is answered as one, never silently downgraded
    // to the cookie — a wrong token with a live cookie beside it must 401, or
    // scope mistakes hide behind the browser session during development.
    if (c.req.header('authorization') !== undefined) {
      const principal = tokenPrincipalOf(c);
      if (principal === undefined) return c.json({ error: 'unauthorized' }, 401);
      c.set('principal', principal);
      return next();
    }
    const principal = cookiePrincipalOf(c);
    if (principal === undefined) return c.json({ error: 'unauthorized' }, 401);
    if (principal.kind !== 'token') c.set('sessionId', principal.sessionId);
    c.set('principal', principal);
    await next();
  };

  const csrfGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      return next();
    }
    // Bearer requests carry no ambient credential a third-party page could
    // ride, so CSRF does not apply to them.
    if (c.get('principal')?.kind === 'token') return next();
    if (!disabled) {
      const sessionId = c.get('sessionId');
      if (!verifyCsrfToken(secret, sessionId, c.req.header(CSRF_HEADER))) {
        return c.json({ error: 'missing or invalid CSRF token' }, 403);
      }
    }
    await next();
  };

  const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const principal = c.get('principal');
    if (principal === undefined || principal.kind !== 'admin') {
      return c.json({ error: 'admin only' }, 403);
    }
    return next();
  };

  const requireManager: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const principal = c.get('principal');
    if (principal === undefined || !isManager(principal)) {
      return c.json({ error: 'admin only' }, 403);
    }
    return next();
  };

  return {
    disabled,
    gate,
    csrfGuard,
    requireAdmin,
    requireManager,
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
    login(c, principal = { kind: 'admin' }) {
      const issued = issueSession(db, secret, now(), principal);
      const maxAge = Math.floor(sessionTtlOf(principal.kind) / 1000);
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
    cookiePrincipal(c) {
      if (disabled) return { kind: 'admin', sessionId: DEV_SESSION_ID };
      return cookiePrincipalOf(c);
    },
    refresh(principal) {
      if (disabled) return principal;
      if (principal.kind === 'token') return tokenPrincipal(getApiToken(db, principal.tokenId));
      const session = getAdminSession(db, principal.sessionId);
      return session === undefined || session.expires_at <= now()
        ? undefined
        : sessionPrincipal(session);
    },
  };
}
