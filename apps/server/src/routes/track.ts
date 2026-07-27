import type { HitContext } from '@analytics/shared';
import { type Context, Hono } from 'hono';
import { parseMatomoRequest } from '../ingest/matomo.ts';
import type { HitSink } from '../pipeline/index.ts';

const TRACKING_PATHS = ['/matomo.php', '/piwik.php'];

const TRACKING_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (char) => char.charCodeAt(0),
).buffer as ArrayBuffer;

const GIF_HEADERS = { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' };
const EMPTY_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * Matomo-compatible tracking endpoints. They answer immediately and never
 * return 4xx/5xx for tracking input (CLAUDE.md invariant 4).
 */
export function createTrackRoutes(sink: HitSink): Hono {
  const app = new Hono();
  app.on(['GET', 'POST'], TRACKING_PATHS, async (c) => {
    const body = c.req.method === 'POST' ? await readBody(c) : undefined;
    const { hits, sendImage } = parseMatomoRequest({
      query: new URL(c.req.url).searchParams,
      body,
    });
    if (hits.length > 0) sink(hits, hitContext(c));
    return sendImage ? c.body(TRACKING_GIF, 200, GIF_HEADERS) : c.body(null, 204, EMPTY_HEADERS);
  });
  return app;
}

async function readBody(c: Context): Promise<string | undefined> {
  try {
    return await c.req.text();
  } catch {
    return undefined;
  }
}

function hitContext(c: Context): HitContext {
  return {
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    acceptLanguage: c.req.header('accept-language'),
    receivedAt: Date.now(),
  };
}

/** Deployed behind a reverse proxy, which is the only source of the client address. */
function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? '';
  return c.req.header('x-real-ip') ?? '';
}
