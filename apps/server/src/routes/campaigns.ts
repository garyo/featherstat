import {
  type CampaignAlias,
  CampaignAliasListSchema,
  type CampaignCreate,
  CampaignCreateSchema,
  type CampaignInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { canManageSite, canReadSite, type Principal } from '../auth/principal.ts';
import {
  type CampaignRow,
  createCampaign,
  type Db,
  deleteCampaign,
  getCampaign,
  listCampaignAliases,
  listCampaigns,
  replaceCampaignAliases,
  updateCampaign,
  withWriteTransaction,
} from '../db/index.ts';
import { requestCampaignBackfill, runCampaignBackfill } from '../jobs/campaign-backfill.ts';
import type { AliasCache } from '../pipeline/campaigns.ts';
import { parseDashboardId } from './dashboards.ts';
import { tryWrite } from './segments.ts';

/**
 * The campaign layer's admin surface (docs/03 § Campaigns, docs/04 § 5):
 *
 * - `GET`/`PUT /api/admin/campaign-aliases?site=` — one site's alias rows,
 *   full-list replace (site 0 = install-wide). A PUT invalidates the live
 *   ingest cache and enqueues the chunked backfill in the SAME transaction
 *   as the rows, then kicks the job.
 * - Campaigns registry CRUD under `/api/admin/campaigns`, plus
 *   `GET /api/campaigns?site=` for any principal behind the gate that can
 *   read the site — the `campaign_status` dimension reads the registry at
 *   query time, so a client offering the dimension needs the list the same
 *   way it needs segments.
 */

/** 200 aliases × a few hundred bytes fits many times over. */
const MAX_CAMPAIGN_BODY_BYTES = 256 * 1024;

export interface CampaignRouteOptions {
  /** The live pipeline's alias cache — an alias write must invalidate it.
   * Absent (a query-only server, tests without a pipeline), rows alone move. */
  aliasCache?: AliasCache;
}

export function createCampaignRoutes(
  db: Db,
  auth: Auth,
  options: CampaignRouteOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_CAMPAIGN_BODY_BYTES }));
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  // The read list scopes on the principal, so it carries its own gate too.
  app.use('/api/campaigns', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  // --- Aliases -------------------------------------------------------------

  app.get('/api/admin/campaign-aliases', (c) => {
    const siteId = aliasSiteOf(c);
    if (siteId === undefined) return c.json({ error: 'invalid site id' }, 400);
    return c.json(
      listCampaignAliases(db, siteId).map(
        (row): CampaignAlias => ({
          field: row.field as CampaignAlias['field'],
          alias: row.alias,
          canonical: row.canonical,
        }),
      ),
    );
  });

  app.put('/api/admin/campaign-aliases', async (c) => {
    const siteId = aliasSiteOf(c);
    if (siteId === undefined) return c.json({ error: 'invalid site id' }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = CampaignAliasListSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid alias list', issues: parsed.error.issues }, 400);
    }
    // Rows and the backfill watermark commit together: a crash between them
    // could otherwise leave aliases no rewrite will ever apply to history.
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, siteId, parsed.data);
      requestCampaignBackfill(db);
    });
    // The live ingest cache reloads on next hit; the chunked backfill starts
    // now and the scheduler resumes it after a crash.
    options.aliasCache?.invalidate();
    void runCampaignBackfill(db).catch((error) =>
      console.error('campaign backfill failed:', error),
    );
    return c.json(parsed.data);
  });

  // --- Registry ------------------------------------------------------------

  /** Out-of-scope site answers exactly like nonexistent — a probe learns nothing. */
  const deniedSite = (c: Context, siteId: number): Response | undefined =>
    canManageSite(c.get('principal'), siteId)
      ? undefined
      : c.json({ error: `unknown site ${siteId}` }, 404);

  /** One site's list where `allowed` holds; elsewhere exactly like nonexistent. */
  const listWhere =
    (allowed: (principal: Principal, siteId: number) => boolean) =>
    (c: Context): Response => {
      const siteId = Number(c.req.query('site'));
      if (!Number.isInteger(siteId) || siteId <= 0) {
        return c.json({ error: 'invalid site id' }, 400);
      }
      if (!allowed(c.get('principal'), siteId)) {
        return c.json({ error: `unknown site ${siteId}` }, 404);
      }
      return c.json(listCampaigns(db, siteId).map(toInfo));
    };
  app.get('/api/campaigns', listWhere(canReadSite));
  app.get('/api/admin/campaigns', listWhere(canManageSite));

  app.post('/api/admin/campaigns', async (c) => {
    const siteId = Number(c.req.query('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    const denied = deniedSite(c, siteId);
    if (denied !== undefined) return denied;
    const body = await parseCampaignBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        createCampaign(db, { site_id: siteId, created_at: auth.now(), ...toColumns(body.data) }),
      ),
    );
    if (row instanceof Response) return row;
    return c.json(toInfo(row), 201);
  });

  app.put('/api/admin/campaigns/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid campaign id' }, 400);
    const existing = getCampaign(db, id);
    if (existing === undefined || !canManageSite(c.get('principal'), existing.site_id)) {
      return c.json({ error: `unknown campaign ${id}` }, 404);
    }
    const body = await parseCampaignBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () => updateCampaign(db, id, toColumns(body.data))),
    );
    if (row instanceof Response) return row;
    if (row === undefined) return c.json({ error: `unknown campaign ${id}` }, 404);
    return c.json(toInfo(row));
  });

  app.delete('/api/admin/campaigns/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid campaign id' }, 400);
    const existing = getCampaign(db, id);
    if (existing === undefined || !canManageSite(c.get('principal'), existing.site_id)) {
      return c.json({ error: `unknown campaign ${id}` }, 404);
    }
    const deleted = withWriteTransaction(db, () => deleteCampaign(db, id));
    if (!deleted) return c.json({ error: `unknown campaign ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** Alias rows allow site 0 — the install-wide fallback ingest consults second. */
function aliasSiteOf(c: Context): number | undefined {
  const siteId = Number(c.req.query('site'));
  return Number.isInteger(siteId) && siteId >= 0 ? siteId : undefined;
}

function toColumns(data: CampaignCreate): Omit<CampaignRow, 'id' | 'site_id' | 'created_at'> {
  return {
    name: data.name,
    expected_sources: data.expectedSources === null ? null : JSON.stringify(data.expectedSources),
    expected_mediums: data.expectedMediums === null ? null : JSON.stringify(data.expectedMediums),
    starts_at: data.startsAt,
    ends_at: data.endsAt,
    notes: data.notes,
  };
}

/** A stored JSON column that no longer parses reads as "anything" — fail open
 * to the column's own NULL meaning rather than serve a broken row. */
function parseList(column: string | null): string[] | null {
  if (column === null) return null;
  try {
    const parsed: unknown = JSON.parse(column);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function toInfo(row: CampaignRow): CampaignInfo {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    expectedSources: parseList(row.expected_sources),
    expectedMediums: parseList(row.expected_mediums),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

type ParsedCampaign = { ok: true; data: CampaignCreate } | { ok: false; response: Response };

async function parseCampaignBody(c: Context): Promise<ParsedCampaign> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = CampaignCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid campaign', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
