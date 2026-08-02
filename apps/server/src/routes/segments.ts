import {
  type SegmentCreate,
  SegmentCreateSchema,
  type SegmentFilterNode,
  SegmentFilterNodeSchema,
  type SegmentInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import {
  createSegment,
  type Db,
  deleteSegment,
  listSegments,
  type SegmentRow,
  updateSegment,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';

/**
 * Saved segments (docs/04 § 3): `GET /api/segments` is a read any principal
 * behind the session gate may make — a viewer or token composes queries with
 * segments exactly as the admin does — while every write lives under the
 * `/api/admin/*` wall. Writes validate with `SegmentCreateSchema` (the filter
 * grammar WITHOUT segment refs, so cycles cannot be stored); reads re-parse
 * the stored JSON and fail closed, because a stored row is a boundary too.
 */

/** One filter tree of 32 × 2 KB values fits many times over. */
const MAX_SEGMENT_BODY_BYTES = 256 * 1024;

export function createSegmentRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('/api/admin/*', bodyLimit({ maxSize: MAX_SEGMENT_BODY_BYTES }));
  app.use('/api/admin/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', auth.gate);
  app.use('/api/admin/*', auth.csrfGuard);

  const list = (c: Context): Response => c.json(listSegments(db).flatMap(toInfoOrNothing));
  app.get('/api/segments', list);
  app.get('/api/admin/segments', list);

  app.post('/api/admin/segments', async (c) => {
    const body = await parseSegmentBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        createSegment(db, body.data.name, JSON.stringify(body.data.filter), auth.now()),
      ),
    );
    if (row instanceof Response) return row;
    return c.json(toInfo(row, body.data.filter), 201);
  });

  app.put('/api/admin/segments/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid segment id' }, 400);
    const body = await parseSegmentBody(c);
    if (body.ok === false) return body.response;
    const row = tryWrite(c, () =>
      withWriteTransaction(db, () =>
        updateSegment(db, id, body.data.name, JSON.stringify(body.data.filter), auth.now()),
      ),
    );
    if (row instanceof Response) return row;
    if (row === undefined) return c.json({ error: `unknown segment ${id}` }, 404);
    return c.json(toInfo(row, body.data.filter));
  });

  app.delete('/api/admin/segments/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid segment id' }, 400);
    const deleted = withWriteTransaction(db, () => deleteSegment(db, id));
    if (!deleted) return c.json({ error: `unknown segment ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function toInfo(
  row: Pick<SegmentRow, 'id' | 'name' | 'updated_at'>,
  filter: SegmentFilterNode,
): SegmentInfo {
  return { id: row.id, name: row.name, filter, updatedAt: row.updated_at };
}

/** A stored row that no longer parses is logged and omitted — never served broken. */
function toInfoOrNothing(row: SegmentRow): SegmentInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(row.filter);
  } catch {
    raw = undefined;
  }
  const parsed = SegmentFilterNodeSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`segments: stored segment ${row.id} ('${row.name}') has an invalid filter`);
    return [];
  }
  return [toInfo(row, parsed.data)];
}

type Parsed = { ok: true; data: SegmentCreate } | { ok: false; response: Response };

async function parseSegmentBody(c: Context): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = SegmentCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid segment', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

/** The one storage-level refusal: `segments.name` is UNIQUE. */
export function tryWrite<T>(c: Context, write: () => T): T | Response {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'that name is already taken' }, 409);
    }
    throw error;
  }
}
