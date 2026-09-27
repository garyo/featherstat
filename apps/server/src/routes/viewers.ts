import { createHash, randomBytes } from 'node:crypto';
import {
  DAY_MS,
  isLinkToken,
  LINK_TOKEN_BYTES,
  LINK_TOKEN_PREFIX,
  type MagicLinkMinted,
  type ViewerInfo,
  ViewerInviteSchema,
} from '@featherstat/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { canGrantScope, parseSiteScope, serializeSiteScope } from '../auth/principal.ts';
import { FailureBudget } from '../auth/ratelimit.ts';
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
 * The admin mints a single-use magic link and delivers it out of band. Visiting
 * `/invite/<token>` only loads the SPA page; its button POSTs `/invite/:token`,
 * which consumes the link and issues a 90-day sliding viewer session — so a
 * link unfurler's GET cannot burn it, and a cross-site form cannot plant a
 * session (the POST must be JSON, which no form can send without a preflight).
 * Mint/list/revoke live under the admin wall; the claim route is public — it is
 * not under `/api/`, so the prefix gate skips it, exactly like `/share/:token`.
 *
 * The raw link token (`fsv_<43 base64url>`) appears exactly once, in the mint
 * response — only its sha256 is stored, so a leaked DB claims nothing.
 */

const MAGIC_LINK_TTL_MS = 7 * DAY_MS;
/** Viewer bodies are an email and a site list — far under this. */
const MAX_VIEWER_BODY_BYTES = 64 * 1024;

/**
 * The claim route is unauthenticated and keyed on the IP, like `/share/:token`.
 * Only dead links are charged (FailureBudget): a legitimate viewer claims once
 * and never fails, so anything sustained here is a token probe — and a probe
 * flood must not stop a live link from claiming. A claim names no account.
 */
export const CLAIM_FAILURES = { perAddress: 10, global: 60, windowMs: 60_000 };
export const CLAIM_ACCOUNT = 'link';

/**
 * The delivery seam: featherstat has no SMTP, so the default just logs that a
 * link was minted (never the link itself — the response is its one appearance).
 * An SMTP/ntfy integration later replaces this one function and nothing else.
 */
type DeliverInvite = (viewer: ViewerRow, url: string) => void;

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
  const failures = new FailureBudget(CLAIM_FAILURES);

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
    const raw = `${LINK_TOKEN_PREFIX.viewer}${randomBytes(LINK_TOKEN_BYTES).toString('base64url')}`;
    const expiresAt = auth.now() + MAGIC_LINK_TTL_MS;
    insertMagicLink(db, {
      token_hash: sha256(raw),
      viewer_id: viewer.id,
      user_id: null,
      purpose: 'viewer-login',
      created_at: auth.now(),
      expires_at: expiresAt,
    });
    const minted: MagicLinkMinted = { viewerId: viewer.id, url: `/invite/${raw}`, expiresAt };
    deliver(viewer, minted.url);
    return minted;
  };

  /** A user sees and revokes only viewers they invited; the admin sees all. */
  const ownsMint = (c: Context, createdBy: number | null): boolean => {
    const principal = c.get('principal');
    return principal.kind !== 'user' || createdBy === principal.userId;
  };

  app.get('/api/admin/viewers', (c) =>
    c.json(
      listViewers(db)
        .filter((viewer) => ownsMint(c, viewer.created_by_user_id))
        .map(toViewerInfo),
    ),
  );

  app.post('/api/admin/viewers', async (c) => {
    const body = await parseBody(c);
    if (body.ok === false) return body.response;
    const principal = c.get('principal');
    if (!canGrantScope(principal, body.data.sites)) {
      return c.json({ error: 'scope exceeds your sites' }, 400);
    }
    const scope = serializeSiteScope(body.data.sites);
    const minted = withWriteTransaction(db, () => {
      pruneMagicLinks(db, auth.now()); // opportunistic sweep — no timer needed
      const existing = getViewerByEmail(db, body.data.email);
      // Someone else's invitee cannot be re-scoped out from under them.
      if (existing !== undefined && !ownsMint(c, existing.created_by_user_id)) return 'conflict';
      // Inviting an existing email is a re-invite: the scope updates and any
      // revocation clears — an explicit decision to restore access.
      const viewer =
        existing === undefined
          ? insertViewer(db, {
              email: body.data.email,
              site_scope: scope,
              created_at: auth.now(),
              created_by_user_id: principal.kind === 'user' ? principal.userId : null,
            })
          : (reinviteViewer(db, existing.id, scope) ?? existing);
      return mintLink(viewer);
    });
    if (minted === 'conflict') return c.json({ error: 'email already invited' }, 409);
    return c.json(minted, 201);
  });

  app.post('/api/admin/viewers/:id/invite', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid viewer id' }, 400);
    const minted = withWriteTransaction(db, () => {
      const viewer = getViewer(db, id);
      if (viewer === undefined || viewer.revoked_at !== null) return undefined;
      // Someone else's mint answers exactly like a nonexistent one.
      if (!ownsMint(c, viewer.created_by_user_id)) return undefined;
      return mintLink(viewer);
    });
    if (minted === undefined) return c.json({ error: `no live viewer ${id}` }, 404);
    return c.json(minted, 201);
  });

  app.delete('/api/admin/viewers/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid viewer id' }, 400);
    // Viewer and links revoke together; live sessions die at the gate, which
    // re-reads the viewer row on every request, and an open realtime stream
    // closes on its next tick (auth.ts `refresh`, realtime/sse.ts).
    const revoked = withWriteTransaction(db, () => {
      const viewer = getViewer(db, id);
      if (viewer === undefined || !ownsMint(c, viewer.created_by_user_id)) return false;
      const gone = revokeViewer(db, id, auth.now());
      if (gone) expireViewerMagicLinks(db, id, auth.now());
      return gone;
    });
    if (!revoked) return c.json({ error: `no live viewer ${id}` }, 404);
    return c.json({ ok: true });
  });

  app.post('/invite/:token', jsonOnly, (c) => {
    const address = clientIp(c);
    if (failures.refuses(address, CLAIM_ACCOUNT, auth.now())) {
      return c.json({ error: 'too many attempts — try again in a minute' }, 429, {
        'Retry-After': '60',
      });
    }
    const dead = (): Response => {
      failures.fail(address, CLAIM_ACCOUNT, auth.now());
      return deadLink(c);
    };
    const raw = c.req.param('token');
    // Malformed, unknown, used, expired and revoked all answer identically —
    // a probe learns nothing, and the tokens are unguessable anyway.
    if (!isLinkToken('viewer', raw)) return dead();
    const viewerId = withWriteTransaction(db, () => {
      const link = getMagicLink(db, sha256(raw));
      if (link === undefined || link.viewer_id === null) return undefined;
      const viewer = getViewer(db, link.viewer_id);
      if (viewer === undefined || viewer.revoked_at !== null) return undefined;
      // The UPDATE is the claim: single use even under concurrent requests.
      if (!consumeMagicLink(db, link.token_hash, auth.now())) return undefined;
      return viewer.id;
    });
    if (viewerId === undefined) return dead();
    const issued = auth.login(c, { kind: 'viewer', viewerId });
    return c.json({ ok: true, csrf: issued.csrfToken });
  });

  return app;
}

/**
 * The public claim routes sign someone in, so a cross-site page must not be
 * able to fire them: a form can only send form or text bodies, and a
 * cross-origin `application/json` POST needs a preflight nothing here answers.
 */
export const jsonOnly: MiddlewareHandler = async (c, next) => {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'send the claim as application/json' }, 415);
  }
  return next();
};

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
