import { createHash, randomBytes } from 'node:crypto';
import {
  DAY_MS,
  UserClaimSchema,
  UserCreateSchema,
  type UserInfo,
  type UserInviteMinted,
  UserSitesSchema,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { hashPassword } from '../auth/password.ts';
import { narrowScope, parseSiteScope, serializeSiteScope } from '../auth/principal.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  consumeMagicLink,
  type Db,
  deleteUserSessions,
  disableUser,
  enableUser,
  expireUserMagicLinks,
  expireViewerMagicLinks,
  getMagicLink,
  getSite,
  getUser,
  getUserByEmail,
  insertMagicLink,
  insertUser,
  listApiTokens,
  listUserSites,
  listUsers,
  listViewers,
  pruneMagicLinks,
  revokeApiToken,
  revokeViewer,
  setApiTokenScope,
  setUserPassword,
  setUserSites,
  setViewerScope,
  type UserRow,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';
import { clientIp } from './track.ts';
import { jsonOnly } from './viewers.ts';

/**
 * Users (docs/04 § 5): password-holding accounts that own and manage sites.
 * The admin creates one by email and mints a single-use invite link, delivered
 * out of band exactly like a viewer's; claiming it at `POST /claim/:token`
 * sets the user's first password and signs them in. Re-inviting doubles as a
 * password reset — the old hash stays valid until the new link is claimed,
 * and the claim ends every session the old one opened.
 *
 * Mint/list/reassign/disable live under the admin wall; the claim route is
 * public — not under `/api/`, so the prefix gate skips it, like `/invite`.
 */

const MAGIC_LINK_TTL_MS = 7 * DAY_MS;
/** `fsu_` + base64url of 32 random bytes — anything else can't be ours. */
const LINK_TOKEN_SHAPE = /^fsu_[A-Za-z0-9_-]{43}$/;
/** User bodies are an email, a site list, or a password — far under this. */
const MAX_USER_BODY_BYTES = 64 * 1024;

/** Same posture as the viewer claim route: attempts are charged, not successes. */
const CLAIMS_PER_IP = 10;
const CLAIMS_GLOBAL = 60;
const CLAIM_WINDOW_MS = 60_000;

/** The delivery seam, mirroring viewers.ts: no SMTP, so the default just logs. */
export type DeliverUserInvite = (user: UserRow, url: string) => void;

const logInvite: DeliverUserInvite = (user) => {
  console.log(`user invite minted for ${user.email} — copy the link from the admin response`);
};

export interface UserRouteOptions {
  deliver?: DeliverUserInvite;
}

export function createUserRoutes(
  db: Db,
  auth: Auth,
  options: UserRouteOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const deliver = options.deliver ?? logInvite;
  const ipClaims = new RateLimiter(CLAIMS_PER_IP, CLAIM_WINDOW_MS);
  const globalClaims = new RateLimiter(CLAIMS_GLOBAL, CLAIM_WINDOW_MS);

  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_USER_BODY_BYTES }));
  // Mint responses carry the raw link — never cacheable.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  /** Mints inside an open transaction; the caller wraps. */
  const mintInvite = (user: UserRow): UserInviteMinted => {
    const raw = `fsu_${randomBytes(32).toString('base64url')}`;
    const expiresAt = auth.now() + MAGIC_LINK_TTL_MS;
    insertMagicLink(db, {
      token_hash: sha256(raw),
      viewer_id: null,
      user_id: user.id,
      purpose: 'user-invite',
      created_at: auth.now(),
      expires_at: expiresAt,
    });
    const minted: UserInviteMinted = { userId: user.id, url: `/welcome/${raw}`, expiresAt };
    deliver(user, minted.url);
    return minted;
  };

  app.get('/api/admin/users', (c) =>
    c.json(listUsers(db).map((user) => toUserInfo(user, listUserSites(db, user.id)))),
  );

  app.post('/api/admin/users', async (c) => {
    const body = await parseBody(c, UserCreateSchema);
    if (body.ok === false) return body.response;
    const minted = withWriteTransaction(db, () => {
      pruneMagicLinks(db, auth.now()); // opportunistic sweep — no timer needed
      const existing = getUserByEmail(db, body.data.email);
      // An existing email is a re-invite: access is restored and a fresh link
      // minted — a password reset. The site assignment stays as it was; that
      // is PATCH's job.
      if (existing !== undefined) {
        enableUser(db, existing.id);
        return mintInvite(existing);
      }
      const user = insertUser(db, body.data.email, auth.now());
      const sites = body.data.sites.filter((siteId) => getSite(db, siteId) !== undefined);
      setUserSites(db, user.id, sites);
      return mintInvite(user);
    });
    return c.json(minted, 201);
  });

  app.post('/api/admin/users/:id/invite', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid user id' }, 400);
    const minted = withWriteTransaction(db, () => {
      const user = getUser(db, id);
      if (user === undefined || user.disabled_at !== null) return undefined;
      return mintInvite(user);
    });
    if (minted === undefined) return c.json({ error: `no active user ${id}` }, 404);
    return c.json(minted, 201);
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid user id' }, 400);
    const body = await parseBody(c, UserSitesSchema);
    if (body.ok === false) return body.response;
    const info = withWriteTransaction(db, () => {
      const user = getUser(db, id);
      if (user === undefined) return undefined;
      const sites = body.data.sites.filter((siteId) => getSite(db, siteId) !== undefined);
      setUserSites(db, id, sites);
      fitGrants(db, id, sites, auth.now());
      return toUserInfo(user, sites);
    });
    if (info === undefined) return c.json({ error: `unknown user ${id}` }, 404);
    return c.json(info);
  });

  app.delete('/api/admin/users/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid user id' }, 400);
    // User, invites, sessions and every grant they minted go together; a
    // re-invite restores the account, never the grants.
    const disabled = withWriteTransaction(db, () => {
      const gone = disableUser(db, id, auth.now());
      if (gone) {
        expireUserMagicLinks(db, id, auth.now());
        deleteUserSessions(db, id);
        fitGrants(db, id, [], auth.now());
      }
      return gone;
    });
    if (!disabled) return c.json({ error: `no active user ${id}` }, 404);
    return c.json({ ok: true });
  });

  app.post('/claim/:token', bodyLimit({ maxSize: MAX_USER_BODY_BYTES }), jsonOnly, async (c) => {
    if (!ipClaims.allow(clientIp(c), auth.now()) || !globalClaims.allow('*', auth.now())) {
      return c.json({ error: 'too many attempts — try again in a minute' }, 429, {
        'Retry-After': '60',
      });
    }
    const raw = c.req.param('token');
    // Malformed, unknown, used, expired and disabled all answer identically —
    // a probe learns nothing, and the tokens are unguessable anyway.
    if (!LINK_TOKEN_SHAPE.test(raw)) return deadLink(c);
    const body = await parseBody(c, UserClaimSchema);
    if (body.ok === false) return body.response;
    // Hashing is async and the write transaction is not: derive first, spend
    // one scrypt on a dead token rather than opening the transaction twice.
    const passwordHash = await hashPassword(body.data.password);
    const userId = withWriteTransaction(db, () => {
      const link = getMagicLink(db, sha256(raw));
      if (link === undefined || link.user_id === null || link.purpose !== 'user-invite') {
        return undefined;
      }
      const user = getUser(db, link.user_id);
      if (user === undefined || user.disabled_at !== null) return undefined;
      // The UPDATE is the claim: single use even under concurrent requests.
      if (!consumeMagicLink(db, link.token_hash, auth.now())) return undefined;
      setUserPassword(db, user.id, passwordHash);
      // A claim may be a password reset: whoever held the old password is
      // signed out everywhere; the claim's own session is issued after this.
      deleteUserSessions(db, user.id);
      return user.id;
    });
    if (userId === undefined) return deadLink(c);
    const issued = auth.login(c, { kind: 'user', userId });
    return c.json({ ok: true, csrf: issued.csrfToken });
  });

  return app;
}

/**
 * Keeps a user's standing grants inside their power, in the caller's
 * transaction: every live token and viewer they minted narrows to `sites`, and
 * one left with no site is revoked (a viewer's outstanding links with it).
 * Share links are not grants of the user's — they belong to the dashboard, and
 * whoever manages its site now revokes them (docs/04 § 5).
 */
function fitGrants(db: Db, userId: number, sites: readonly number[], now: number): void {
  const owned = new Set(sites);
  for (const token of listApiTokens(db)) {
    if (token.created_by_user_id !== userId || token.revoked_at !== null) continue;
    const kept = narrowScope(parseSiteScope(token.site_scope), owned);
    if (kept === undefined) continue;
    if (kept.length === 0) revokeApiToken(db, token.id, now);
    else setApiTokenScope(db, token.id, serializeSiteScope(kept));
  }
  for (const viewer of listViewers(db)) {
    if (viewer.created_by_user_id !== userId || viewer.revoked_at !== null) continue;
    const kept = narrowScope(parseSiteScope(viewer.site_scope), owned);
    if (kept === undefined) continue;
    if (kept.length > 0) {
      setViewerScope(db, viewer.id, serializeSiteScope(kept));
    } else {
      revokeViewer(db, viewer.id, now);
      expireViewerMagicLinks(db, viewer.id, now);
    }
  }
}

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function deadLink(c: Context): Response {
  return c.json({ error: 'this invite link is invalid, already used, or expired' }, 410);
}

function toUserInfo(row: UserRow, sites: number[]): UserInfo {
  return {
    id: row.id,
    email: row.email,
    sites,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    hasPassword: row.password_hash !== null,
  };
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The slice of a zod schema this file uses — keeps zod out of the server's own deps. */
interface SchemaLike<T> {
  safeParse(
    raw: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/** Admin endpoints are not beacons: malformed bodies get a 400 with the zod issues. */
async function parseBody<T>(c: Context, schema: SchemaLike<T>): Promise<Parsed<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid request', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
