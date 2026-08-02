import {
  type DerivedMetricCreate,
  DerivedMetricCreateSchema,
  type DerivedMetricInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import {
  createDerivedMetric,
  type Db,
  type DerivedMetricRow,
  deleteDerivedMetric,
  listDerivedMetrics,
  updateDerivedMetric,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';
import { tryWrite } from './segments.ts';

/**
 * Derived metrics (docs/04 § 3): the segments pattern exactly — a read for any
 * principal behind the session gate (`GET /api/derived-metrics`, so a client
 * can offer `d:<name>` beside the built-ins), writes under the `/api/admin/*`
 * wall. `DerivedMetricCreateSchema` parses the expression on every write; the
 * executor re-parses on every read and fails closed to a per-query error.
 */

/** An expression is ≤200 chars; anything near this limit is not a metric. */
const MAX_DERIVED_BODY_BYTES = 16 * 1024;

export function createDerivedMetricRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_DERIVED_BODY_BYTES }));
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  const list = (c: Context): Response => c.json(listDerivedMetrics(db).map(toInfo));
  app.get('/api/derived-metrics', list);
  app.get('/api/admin/derived-metrics', list);

  app.post('/api/admin/derived-metrics', async (c) => {
    const body = await parseDerivedBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        createDerivedMetric(db, body.data.name, body.data.expr, auth.now()),
      ),
    );
    if (row instanceof Response) return row;
    return c.json(toInfo(row), 201);
  });

  app.put('/api/admin/derived-metrics/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid derived metric id' }, 400);
    const body = await parseDerivedBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        updateDerivedMetric(db, id, body.data.name, body.data.expr, auth.now()),
      ),
    );
    if (row instanceof Response) return row;
    if (row === undefined) return c.json({ error: `unknown derived metric ${id}` }, 404);
    return c.json(toInfo(row));
  });

  app.delete('/api/admin/derived-metrics/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid derived metric id' }, 400);
    const deleted = withWriteTransaction(db, () => deleteDerivedMetric(db, id));
    if (!deleted) return c.json({ error: `unknown derived metric ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function toInfo(row: DerivedMetricRow): DerivedMetricInfo {
  return { id: row.id, name: row.name, expr: row.expr, updatedAt: row.updated_at };
}

type Parsed = { ok: true; data: DerivedMetricCreate } | { ok: false; response: Response };

async function parseDerivedBody(c: Context): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = DerivedMetricCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid derived metric', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
