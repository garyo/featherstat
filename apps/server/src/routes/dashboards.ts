import {
  type Dashboard,
  DashboardSchema,
  dashboardBatchIssue,
  dashboardTemplate,
  readStoredDashboard,
  upgradeDashboard,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { canReadSite, type Principal } from '../auth/principal.ts';
import {
  countLiveShareTokens,
  createDashboard,
  type DashboardRow,
  type Db,
  deleteDashboard,
  getDashboard,
  listDashboards,
  listSites,
  type NewDashboard,
  updateDashboard,
  withWriteTransaction,
} from '../db/index.ts';

/**
 * `/api/admin/dashboards` (docs/04 § 5, docs/05 § Widgets): CRUD over the stored
 * dashboard JSON. Every write revalidates the whole layout with `DashboardSchema`
 * AND the batch invariants (`dashboardBatchIssue`: unique query ids, derived
 * query count within `MAX_QUERIES_PER_BATCH`) — an invalid document is a 400 and
 * never stored. Reads still re-validate before executing or returning a layout:
 * a stored row is a boundary too (CLAUDE.md: zod at every boundary, JSON columns
 * included).
 */

/** 24 widgets × a query with 16 × 2 KB filter values still fit several times over. */
const MAX_DASHBOARD_BODY_BYTES = 256 * 1024;

/** List row: enough for the library picker without shipping every layout. */
export interface DashboardInfo {
  id: number;
  name: string;
  site: Dashboard['site'];
  /** Shipped-template id this row was cloned from (the reset target); null otherwise. */
  template: string | null;
  createdAt: number;
  updatedAt: number;
  /** LIVE share links pointing at this row — what a delete would revoke. */
  shareCount: number;
}

export interface DashboardDetail extends DashboardInfo {
  layout: Dashboard;
}

export function createDashboardRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_DASHBOARD_BODY_BYTES }));
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  // --- Reads for any principal (docs/04 § 5) --------------------------------
  // A viewer or token reads dashboards here; the `/api/admin/dashboards` paths
  // below keep serving the SPA unchanged (its migration is a later concern).
  // Scope rule, simplest honest one: a site-scoped dashboard is visible to any
  // principal that can read its site; an 'all'-sites dashboard aggregates
  // every site, so it is visible only to principals whose own scope is 'all'.
  // Out of scope answers exactly like nonexistent (404), as everywhere else.

  app.get('/api/dashboards', (c) =>
    c.json(
      listDashboards(db)
        .filter((row) => visibleTo(c.get('principal'), row))
        .map((row) => toInfo(row, row.share_count)),
    ),
  );

  app.get('/api/dashboards/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined || !visibleTo(c.get('principal'), row)) {
      return c.json({ error: `unknown dashboard ${id}` }, 404);
    }
    const detail = toDetail(db, row);
    if (detail === undefined) {
      console.error(`dashboards: stored dashboard ${id} has an invalid layout`);
      return c.json({ error: `stored dashboard ${id} is invalid — save a fresh layout` }, 500);
    }
    return c.json(detail);
  });

  app.get('/api/admin/dashboards', (c) =>
    c.json(listDashboards(db).map((row) => toInfo(row, row.share_count))),
  );

  app.get('/api/admin/dashboards/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    const detail = toDetail(db, row);
    if (detail === undefined) {
      console.error(`dashboards: stored dashboard ${id} has an invalid layout`);
      return c.json({ error: `stored dashboard ${id} is invalid — save a fresh layout` }, 500);
    }
    return c.json(detail);
  });

  app.post('/api/admin/dashboards', async (c) => {
    // `?template=<id>` records which shipped template this row was cloned from —
    // the reset target. Validated against the shared registry: the column powers
    // reset, so an id reset cannot rebuild from must never be stored.
    const template = c.req.query('template') ?? null;
    if (template !== null && dashboardTemplate(template) === undefined) {
      return c.json({ error: `unknown template '${template}'` }, 400);
    }
    const body = await parseLayoutBody(c);
    if (body.ok === false) return body.response;
    const row = withWriteTransaction(db, () =>
      createDashboard(db, toRow(body.data, template, auth.now())),
    );
    return c.json({ ...toInfo(row, 0), layout: body.data }, 201);
  });

  app.put('/api/admin/dashboards/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const body = await parseLayoutBody(c);
    if (body.ok === false) return body.response;
    const row = withWriteTransaction(db, () =>
      updateDashboard(db, id, toRow(body.data, null, auth.now())),
    );
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    return c.json({ ...toInfo(row, countLiveShareTokens(db, id)), layout: body.data });
  });

  // A copy of a stored row: same layout and template lineage, fresh identity —
  // and no share links, which point at rows, not layouts.
  app.post('/api/admin/dashboards/:id/duplicate', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    const layout = readStoredDashboard(row.layout);
    if (layout === undefined) {
      console.error(`dashboards: stored dashboard ${id} has an invalid layout`);
      return c.json({ error: `stored dashboard ${id} is invalid — save a fresh layout` }, 500);
    }
    const copy: Dashboard = { ...layout, name: `${row.name} copy` };
    const created = withWriteTransaction(db, () =>
      createDashboard(db, { ...toRow(copy, null, auth.now()), template: row.template }),
    );
    return c.json({ ...toInfo(created, 0), layout: copy }, 201);
  });

  // Reset a clone to its shipped template, at the current vocabulary. The row's
  // NAME survives — a rename is identity, not layout — and a row that was never
  // cloned from a template has nothing to reset to.
  app.post('/api/admin/dashboards/:id/reset', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    const template = row.template === null ? undefined : dashboardTemplate(row.template);
    if (template === undefined) {
      return c.json(
        { error: `dashboard ${id} was not cloned from a shipped template — nothing to reset to` },
        409,
      );
    }
    const siteIds = listSites(db).map((site) => site.id);
    const built = template.build(siteOf(row), siteIds);
    const layout: Dashboard = { ...built, name: row.name };
    const updated = withWriteTransaction(db, () =>
      updateDashboard(db, id, toRow(layout, null, auth.now())),
    );
    if (updated === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    return c.json({ ...toInfo(updated, countLiveShareTokens(db, id)), layout });
  });

  app.delete('/api/admin/dashboards/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const deleted = withWriteTransaction(db, () => deleteDashboard(db, id));
    if (!deleted) return c.json({ error: `unknown dashboard ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** The scope rule above. Undefined = mounted without the gate (bare tests) — open, like sites.ts. */
function visibleTo(who: Principal | undefined, row: DashboardRow): boolean {
  if (who === undefined || who.kind === 'admin') return true;
  const site = siteOf(row);
  return site === 'all' ? who.sites === 'all' : canReadSite(who, site);
}

/** A positive integer path param, or undefined — shared with the share routes. */
export function parseDashboardId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function toRow(layout: Dashboard, template: string | null, now: number): NewDashboard {
  return {
    name: layout.name,
    site_scope: String(layout.site),
    layout: JSON.stringify(layout),
    template,
    updated_at: now,
  };
}

function toInfo(row: DashboardRow, shareCount: number): DashboardInfo {
  return {
    id: row.id,
    name: row.name,
    site: siteOf(row),
    template: row.template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shareCount,
  };
}

/** Undefined when the stored layout no longer validates (schema OR batch
 * invariants) — the caller decides how loudly. A layout this returns is at the
 * current vocabulary and is one `collectBatch` can turn into a fetchable
 * request. The row itself is left as it was: the upgrade is a read, not a write. */
function toDetail(db: Db, row: DashboardRow): DashboardDetail | undefined {
  const layout = readStoredDashboard(row.layout);
  if (layout === undefined) return undefined;
  return { ...toInfo(row, countLiveShareTokens(db, row.id)), layout };
}

function siteOf(row: DashboardRow): Dashboard['site'] {
  return row.site_scope === 'all' ? 'all' : Number(row.site_scope);
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
      response: c.json({ error: 'invalid dashboard layout', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Schema-valid AND batchable — what a write must be before it is stored. */
async function parseLayoutBody(c: Context): Promise<Parsed<Dashboard>> {
  const body = await parseBody(c, DashboardSchema);
  if (body.ok === false) return body;
  // Carried forward on the way in as well as on the way out, so a save from a
  // client that speaks an older vocabulary stores the current one and the row
  // converges — without any read path ever writing to the database.
  const layout = upgradeDashboard(body.data);
  const issue = dashboardBatchIssue(layout);
  if (issue !== undefined) return { ok: false, response: c.json({ error: issue }, 400) };
  return { ok: true, data: layout };
}
