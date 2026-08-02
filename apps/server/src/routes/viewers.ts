import { createHash, randomBytes } from 'node:crypto';
import {
  DAY_MS,
  type MagicLinkMinted,
  type ViewerInfo,
  ViewerInviteSchema,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { parseSiteScope, serializeSiteScope } from '../auth/principal.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import {
  consumeMagicLink,
  type Db,
  expireViewerMagicLinks,
  getMagicLink,
  getViewer,
  getViewerByEmail,
  insertMagicLink,
  insertViewer,
  listViewers,
  pruneMagicLinks,
  reinviteViewer,
  revokeViewer,
  type ViewerRow,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';
import { clientIp } from './track.ts';

/**
 * Viewers (docs/04 § 5): invited read-only principals, claimed without SMTP.
 * The admin mints a single-use magic link and delivers it out of band; visiting
 * `GET /invite/:token` consumes it and issues a 90-day sliding viewer session.
 * Mint/list/revoke live under the admin wall; the claim route is public — it is
 * not under `/api/`, so the prefix gate skips it, exactly like `/share/:token`.
 *
 * The raw link token (`fsv_<43 base64url>`) appears exactly once, in the mint
 * response — only its sha256 is stored, so a leaked DB claims nothing.
 */

const MAGIC_LINK_TTL_MS = 7 * DAY_MS;
/** `fsv_` + base64url of 32 random bytes — anything else can't be ours. */
const LINK_TOKEN_SHAPE = /^fsv_[A-Za-z0-9_-]{43}$/;
/** Viewer bodies are an email and a site list — far under this. */
const MAX_VIEWER_BODY_BYTES = 64 * 1024;

/**
 * The claim route is unauthenticated and keyed on the IP, like `/share/:token`
 * — and tighter: a legitimate viewer claims once, so anything sustained here is
 * a token probe. Attempts are charged (`allow`), not just successes.
 */
const CLAIMS_PER_IP = 10;
const CLAIMS_GLOBAL = 60;
const CLAIM_WINDOW_MS = 60_000;

/**
 * The delivery seam: featherstat has no SMTP, so the default just logs that a
 * link was minted (never the link itself — the response is its one appearance).
 * An SMTP/ntfy integration later replaces this one function and nothing else.
 */
export type DeliverInvite = (viewer: ViewerRow, url: string) => void;

const logInvite: DeliverInvite = (viewer) => {
  console.log(`viewer invite minted for ${viewer.email} — copy the link from the admin response`);
};

export interface ViewerRouteOptions {
  deliver?: DeliverInvite;
}

export function createViewerRoutes(
  db: Db,
  auth: Auth,
  options: ViewerRouteOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const deliver = options.deliver ?? logInvite;
  const ipClaims = new RateLimiter(CLAIMS_PER_IP, CLAIM_WINDOW_MS);
  const globalClaims = new RateLimiter(CLAIMS_GLOBAL, CLAIM_WINDOW_MS);

  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_VIEWER_BODY_BYTES }));
  // Mint responses carry the raw link — never cacheable.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  /** Mints inside an open transaction; the caller wraps. */
  const mintLink = (viewer: ViewerRow): MagicLinkMinted => {
    const raw = `fsv_${randomBytes(32).toString('base64url')}`;
    const expiresAt = auth.now() + MAGIC_LINK_TTL_MS;
    insertMagicLink(db, {
      token_hash: sha256(raw),
      viewer_id: viewer.id,
      created_at: auth.now(),
      expires_at: expiresAt,
    });
    const minted: MagicLinkMinted = { viewerId: viewer.id, url: `/invite/${raw}`, expiresAt };
    deliver(viewer, minted.url);
    return minted;
  };

  app.get('/api/admin/viewers', (c) => c.json(listViewers(db).map(toViewerInfo)));

  app.post('/api/admin/viewers', async (c) => {
    const body = await parseBody(c);
    if (body.ok === false) return body.response;
    const scope = serializeSiteScope(body.data.sites);
    const minted = withWriteTransaction(db, () => {
      pruneMagicLinks(db, auth.now()); // opportunistic sweep — no timer needed
      const existing = getViewerByEmail(db, body.data.email);
      // Inviting an existing email is a re-invite: the scope updates and any
      // revocation clears — an explicit decision to restore access.
      const viewer =
        existing === undefined
          ? insertViewer(db, { email: body.data.email, site_scope: scope, created_at: auth.now() })
          : (reinviteViewer(db, existing.id, scope) ?? existing);
      return mintLink(viewer);
    });
    return c.json(minted, 201);
  });

  app.post('/api/admin/viewers/:id/invite', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid viewer id' }, 400);
    const minted = withWriteTransaction(db, () => {
      const viewer = getViewer(db, id);
      if (viewer === undefined || viewer.revoked_at !== null) return undefined;
      return mintLink(viewer);
    });
    if (minted === undefined) return c.json({ error: `no live viewer ${id}` }, 404);
    return c.json(minted, 201);
  });

  app.delete('/api/admin/viewers/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid viewer id' }, 400);
    // Viewer and links revoke together; live sessions die at the gate, which
    // re-reads the viewer row on every request (auth.ts, principal.test.ts).
    const revoked = withWriteTransaction(db, () => {
      const gone = revokeViewer(db, id, auth.now());
      if (gone) expireViewerMagicLinks(db, id, auth.now());
      return gone;
    });
    if (!revoked) return c.json({ error: `no live viewer ${id}` }, 404);
    return c.json({ ok: true });
  });

  app.get('/invite/:token', (c) => {
    if (!ipClaims.allow(clientIp(c), auth.now()) || !globalClaims.allow('*', auth.now())) {
      return c.json({ error: 'too many attempts — try again in a minute' }, 429, {
        'Retry-After': '60',
      });
    }
    const raw = c.req.param('token');
    // Malformed, unknown, used, expired and revoked all answer identically —
    // a probe learns nothing, and the tokens are unguessable anyway.
    if (!LINK_TOKEN_SHAPE.test(raw)) return deadLink(c);
    const viewerId = withWriteTransaction(db, () => {
      const link = getMagicLink(db, sha256(raw));
      if (link === undefined) return undefined;
      const viewer = getViewer(db, link.viewer_id);
      if (viewer === undefined || viewer.revoked_at !== null) return undefined;
      // The UPDATE is the claim: single use even under concurrent requests.
      if (!consumeMagicLink(db, link.token_hash, auth.now())) return undefined;
      return viewer.id;
    });
    if (viewerId === undefined) return deadLink(c);
    auth.login(c, { kind: 'viewer', viewerId });
    return c.redirect('/', 302);
  });

  return app;
}

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function deadLink(c: Context): Response {
  return c.json({ error: 'this invite link is invalid, already used, or expired' }, 410);
}

function toViewerInfo(row: ViewerRow): ViewerInfo {
  const scope = parseSiteScope(row.site_scope);
  return {
    id: row.id,
    email: row.email,
    sites: scope === 'all' ? 'all' : [...scope],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

type Parsed =
  | { ok: true; data: { email: string; sites: 'all' | number[] } }
  | { ok: false; response: Response };

/** Admin endpoints are not beacons: malformed bodies get a 400 with the zod issues. */
async function parseBody(c: Context): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = ViewerInviteSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid invite', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
