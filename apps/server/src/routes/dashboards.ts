import {
  type Dashboard,
  DashboardSchema,
  dashboardBatchIssue,
  readStoredDashboard,
  upgradeDashboard,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import {
  createDashboard,
  type DashboardRow,
  type Db,
  deleteDashboard,
  getDashboard,
  listDashboards,
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

/** List row: enough for a picker without shipping every layout. */
export interface DashboardInfo {
  id: number;
  name: string;
  site: Dashboard['site'];
  updatedAt: number;
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

  app.get('/api/admin/dashboards', (c) => c.json(listDashboards(db).map(toInfo)));

  app.get('/api/admin/dashboards/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const row = getDashboard(db, id);
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    const detail = toDetail(row);
    if (detail === undefined) {
      console.error(`dashboards: stored dashboard ${id} has an invalid layout`);
      return c.json({ error: `stored dashboard ${id} is invalid — save a fresh layout` }, 500);
    }
    return c.json(detail);
  });

  app.post('/api/admin/dashboards', async (c) => {
    const body = await parseLayoutBody(c);
    if (body.ok === false) return body.response;
    const row = withWriteTransaction(db, () => createDashboard(db, toRow(body.data, auth.now())));
    return c.json({ ...toInfo(row), layout: body.data }, 201);
  });

  app.put('/api/admin/dashboards/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid dashboard id' }, 400);
    const body = await parseLayoutBody(c);
    if (body.ok === false) return body.response;
    const row = withWriteTransaction(db, () =>
      updateDashboard(db, id, toRow(body.data, auth.now())),
    );
    if (row === undefined) return c.json({ error: `unknown dashboard ${id}` }, 404);
    return c.json({ ...toInfo(row), layout: body.data });
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

/** A positive integer path param, or undefined — shared with the share routes. */
export function parseDashboardId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function toRow(layout: Dashboard, now: number): NewDashboard {
  return {
    name: layout.name,
    site_scope: String(layout.site),
    layout: JSON.stringify(layout),
    updated_at: now,
  };
}

function toInfo(row: DashboardRow): DashboardInfo {
  return { id: row.id, name: row.name, site: siteOf(row), updatedAt: row.updated_at };
}

/** Undefined when the stored layout no longer validates (schema OR batch
 * invariants) — the caller decides how loudly. A layout this returns is at the
 * current vocabulary and is one `collectBatch` can turn into a fetchable
 * request. The row itself is left as it was: the upgrade is a read, not a write. */
function toDetail(row: DashboardRow): DashboardDetail | undefined {
  const layout = readStoredDashboard(row.layout);
  return layout === undefined ? undefined : { ...toInfo(row), layout };
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
