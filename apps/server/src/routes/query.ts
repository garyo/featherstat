import { createHash } from 'node:crypto';
import { QueryRequestSchema, type SiteWindow } from '@featherstat/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type Db, dataVersion, schemaVersion } from '../db/index.ts';
import { executeQueryRequest, resolveSiteWindows, UnknownSiteError } from '../query/executor.ts';

/**
 * POST /api/query — the batched query endpoint (docs/04 § 3). This is not a
 * beacon: invalid bodies get a 400 with the zod issues. The ETag is a strong
 * hash of (data version, schema version, canonicalized request, resolved
 * per-site windows), so an unchanged dashboard revalidates with a 304 and zero
 * query work — and a preset like `today` still expires at site-local midnight,
 * when its window moves even though no data did.
 */
/** 32 queries × 16 filters of 2 KB values still fit comfortably — beyond this is abuse. */
const MAX_QUERY_BODY_BYTES = 1024 * 1024;

export function createQueryRoutes(db: Db): Hono {
  const app = new Hono();
  app.post('/api/query', bodyLimit({ maxSize: MAX_QUERY_BODY_BYTES }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = QueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid query request', issues: parsed.error.issues }, 400);
    }

    const now = Date.now();
    let windows: SiteWindow[];
    try {
      windows = resolveSiteWindows(db, parsed.data.site, parsed.data.range, now);
    } catch (error) {
      if (error instanceof UnknownSiteError) return c.json({ error: error.message }, 404);
      throw error;
    }

    const canonicalBody = canonicalize(parsed.data);
    const schema = schemaVersion(db);
    const current = etag(dataVersion(db), schema, canonicalBody, windows);
    if (anyMatch(c.req.header('if-none-match'), current)) {
      return c.body(null, 304, { ETag: current });
    }

    const response = executeQueryRequest(db, parsed.data, { now });
    // Re-derived from the executed snapshot's version, in case a flush landed in between.
    const tag = etag(response.meta.dataVersion, schema, canonicalBody, windows);
    return c.json(response, 200, { ETag: tag });
  });
  return app;
}

function anyMatch(ifNoneMatch: string | undefined, current: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((candidate) => candidate.trim() === current);
}

function etag(
  version: number,
  schema: number,
  canonicalBody: string,
  windows: readonly SiteWindow[],
): string {
  const resolved = windows.map((w) => `${w.siteId}:${w.timezone}:${w.from}:${w.to}`).join(',');
  const hash = createHash('sha256')
    .update(`${version}|${schema}|${canonicalBody}|${resolved}`)
    .digest('base64url');
  return `"${hash}"`;
}

/** JSON with object keys sorted, so key order alone can never produce a distinct ETag. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}
