import {
  type AnnotationCreate,
  AnnotationCreateSchema,
  type AnnotationInfo,
} from '@featherstat/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import {
  type AnnotationRow,
  bumpAnnotationsVersion,
  createAnnotation,
  type Db,
  deleteAnnotation,
  getSite,
  listAnnotations,
  updateAnnotation,
  withWriteTransaction,
} from '../db/index.ts';
import { parseDashboardId } from './dashboards.ts';

/**
 * Annotations admin CRUD (docs/04 § 5): operator notes pinned to a moment,
 * listed here and delivered opt-in as `meta.annotations` on the query batch
 * (routes/query.ts). Every write bumps `annotations_version` in the SAME
 * transaction — the counter the annotation-opted ETag hashes, so an edit
 * expires exactly the cached answers that show annotations and no others.
 */

/** 300 chars of text plus envelope — anything bigger is not an annotation. */
const MAX_ANNOTATION_BODY_BYTES = 16 * 1024;

export function createAnnotationRoutes(db: Db, auth: Auth): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  /** A note pinned to a site that does not exist is a mistake, not a row. */
  const checkSite = (c: Context, data: AnnotationCreate): Response | undefined => {
    if (data.siteId === null || getSite(db, data.siteId) !== undefined) return undefined;
    return c.json({ error: `unknown site ${data.siteId}` }, 404);
  };
  app.use('/api/admin/annotations', bodyLimit({ maxSize: MAX_ANNOTATION_BODY_BYTES }));
  app.use('/api/admin/annotations/*', bodyLimit({ maxSize: MAX_ANNOTATION_BODY_BYTES }));
  for (const path of ['/api/admin/annotations', '/api/admin/annotations/*']) {
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.set('Cache-Control', 'no-store');
    });
    app.use(path, auth.gate);
    app.use(path, auth.csrfGuard);
  }

  app.get('/api/admin/annotations', (c) => {
    const site = c.req.query('site');
    if (site === undefined) return c.json(listAnnotations(db).map(toInfo));
    const siteId = parseDashboardId(site);
    if (siteId === undefined) return c.json({ error: 'invalid site id' }, 400);
    return c.json(listAnnotations(db, siteId).map(toInfo));
  });

  app.post('/api/admin/annotations', async (c) => {
    const body = await parseAnnotationBody(c);
    if (body.ok === false) return body.response;
    const unknownSite = checkSite(c, body.data);
    if (unknownSite !== undefined) return unknownSite;
    const row = withWriteTransaction(db, () => {
      const created = createAnnotation(
        db,
        body.data.siteId,
        body.data.ts,
        body.data.text,
        auth.now(),
      );
      bumpAnnotationsVersion(db);
      return created;
    });
    return c.json(toInfo(row), 201);
  });

  app.put('/api/admin/annotations/:id', async (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid annotation id' }, 400);
    const body = await parseAnnotationBody(c);
    if (body.ok === false) return body.response;
    const unknownSite = checkSite(c, body.data);
    if (unknownSite !== undefined) return unknownSite;
    const row = withWriteTransaction(db, () => {
      const updated = updateAnnotation(
        db,
        id,
        body.data.siteId,
        body.data.ts,
        body.data.text,
        auth.now(),
      );
      if (updated !== undefined) bumpAnnotationsVersion(db);
      return updated;
    });
    if (row === undefined) return c.json({ error: `unknown annotation ${id}` }, 404);
    return c.json(toInfo(row));
  });

  app.delete('/api/admin/annotations/:id', (c) => {
    const id = parseDashboardId(c.req.param('id'));
    if (id === undefined) return c.json({ error: 'invalid annotation id' }, 400);
    const deleted = withWriteTransaction(db, () => {
      const gone = deleteAnnotation(db, id);
      if (gone) bumpAnnotationsVersion(db);
      return gone;
    });
    if (!deleted) return c.json({ error: `unknown annotation ${id}` }, 404);
    return c.json({ ok: true });
  });

  return app;
}

export function toInfo(row: AnnotationRow): AnnotationInfo {
  return { id: row.id, siteId: row.site_id, ts: row.ts, text: row.text };
}

type Parsed = { ok: true; data: AnnotationCreate } | { ok: false; response: Response };

async function parseAnnotationBody(c: Context): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const parsed = AnnotationCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: 'invalid annotation', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}
