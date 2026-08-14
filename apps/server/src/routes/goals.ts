import {
  encodeGoalValueExpr,
  type GoalCreate,
  GoalCreateSchema,
  GoalFiltersSchema,
  type GoalInfo,
  parseGoalValueExpr,
  type SegmentFilterNode,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { canManageSite } from '../auth/principal.ts';
import {
  createGoal,
  type Db,
  deleteGoal,
  type GoalRow,
  getGoal,
  listGoals,
  updateGoal,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';
import { tryWrite } from './segments.ts';

/**
 * Goals (docs/04 § 3): the segments pattern — `GET /api/goals?site=` is a read
 * any principal behind the gate may make (a client offering `goal:<id>:…`
 * metrics needs the list), writes live under the `/api/admin/*` wall.
 * `GoalCreateSchema` validates the filter trees on every write; the query
 * layer re-parses them on every read and fails closed to a per-query error.
 */

/** 16 trees of 32 × 2 KB values fit many times over. */
const MAX_GOAL_BODY_BYTES = 256 * 1024;

export function createGoalRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_GOAL_BODY_BYTES }));
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  /** Out-of-scope site answers exactly like nonexistent — a probe learns nothing. */
  const deniedSite = (c: Context, siteId: number): Response | undefined =>
    canManageSite(c.get('principal'), siteId)
      ? undefined
      : c.json({ error: `unknown site ${siteId}` }, 404);

  const list = (c: Context): Response => {
    const siteId = Number(c.req.query('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    return c.json(listGoals(db, siteId).flatMap(toInfoOrNothing));
  };
  app.get('/api/goals', list);
  app.get('/api/admin/goals', (c) => {
    const siteId = Number(c.req.query('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    return deniedSite(c, siteId) ?? list(c);
  });

  app.post('/api/admin/goals', async (c) => {
    const siteId = Number(c.req.query('site'));
    if (!Number.isInteger(siteId) || siteId <= 0) return c.json({ error: 'invalid site id' }, 400);
    const denied = deniedSite(c, siteId);
    if (denied !== undefined) return denied;
    const body = await parseGoalBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        createGoal(db, { site_id: siteId, ...toColumns(body.data) }, auth.now()),
      ),
    );
    if (row instanceof Response) return row;
    return c.json(toInfo(row, body.data.filters), 201);
  });

  app.put('/api/admin/goals/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid goal id' }, 400);
    const existing = getGoal(db, id);
    if (existing === undefined || !canManageSite(c.get('principal'), existing.site_id)) {
      return c.json({ error: `unknown goal ${id}` }, 404);
    }
    const body = await parseGoalBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () => updateGoal(db, id, toColumns(body.data), auth.now())),
    );
    if (row instanceof Response) return row;
    if (row === undefined) return c.json({ error: `unknown goal ${id}` }, 404);
    return c.json(toInfo(row, body.data.filters));
  });

  app.delete('/api/admin/goals/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid goal id' }, 400);
    const existing = getGoal(db, id);
    if (existing === undefined || !canManageSite(c.get('principal'), existing.site_id)) {
      return c.json({ error: `unknown goal ${id}` }, 404);
    }
    const deleted = withWriteTransaction(db, () => deleteGoal(db, id));
    if (!deleted) return c.json({ error: `unknown goal ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function toColumns(data: GoalCreate): Omit<GoalRow, 'id' | 'site_id' | 'updated_at'> {
  return {
    name: data.name,
    filters: JSON.stringify(data.filters),
    value_expr: encodeGoalValueExpr(data.valueExpr),
    target: data.target,
  };
}

function toInfo(
  row: Pick<GoalRow, 'id' | 'site_id' | 'name' | 'value_expr' | 'target' | 'updated_at'>,
  filters: SegmentFilterNode[],
): GoalInfo {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    filters,
    valueExpr: parseGoalValueExpr(row.value_expr),
    target: row.target,
    updatedAt: row.updated_at,
  };
}

/** A stored row that no longer parses is logged and omitted — never served broken. */
function toInfoOrNothing(row: GoalRow): GoalInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(row.filters);
  } catch {
    raw = undefined;
  }
  const parsed = GoalFiltersSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`goals: stored goal ${row.id} ('${row.name}') has invalid filters`);
    return [];
  }
  return [toInfo(row, parsed.data)];
}

type ParsedGoal = { ok: true; data: GoalCreate } | { ok: false; response: Response };

async function parseGoalBody(c: Context): Promise<ParsedGoal> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = GoalCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid goal', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
