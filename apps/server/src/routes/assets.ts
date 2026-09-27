import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ifNoneMatchHits } from './etag.ts';

/** Built by `bun run --cwd packages/tracker build`. */
const DEFAULT_DIST = fileURLToPath(new URL('../../../../packages/tracker/dist/', import.meta.url));

/**
 * A day, revalidated by ETag. The tag URLs are unversioned — every site loads
 * `/matomo.js` — so a longer TTL would strand a tracker fix in caches.
 */
const CACHE_CONTROL = 'public, max-age=86400';
const CONTENT_TYPE = 'text/javascript; charset=utf-8';

/**
 * Every tracked site loads these from another origin, and `tracker.js` is an ES
 * module: a module script is ALWAYS fetched in CORS mode, so without this the
 * native tracker fails with "Failed to fetch dynamically imported module" while
 * a plain GET of the same URL returns 200. The shim is a classic script and
 * needs none of this, but it costs a header and the asymmetry would be a trap.
 */
const ALLOW_ORIGIN = { 'Access-Control-Allow-Origin': '*' };

/** `/piwik.js` is the historical alias of `/matomo.js` (docs/04 § 1). */
const ROUTES: Record<string, string> = {
  '/matomo.js': 'matomo.js',
  '/piwik.js': 'matomo.js',
  '/tracker.js': 'tracker.js',
};

interface Asset {
  body: string;
  etag: string;
}

export interface AssetRoutesOptions {
  /** Directory holding the built bundles; defaults to `packages/tracker/dist`. */
  dir?: string;
}

/**
 * Serves the tracker bundles (docs/04 § 1–2) with long-lived caching and an
 * ETag. Files are read once and kept in memory; a bundle that isn't built yet
 * is a 404 that resolves itself on the next request after a build.
 */
export function createAssetRoutes({ dir = DEFAULT_DIST }: AssetRoutesOptions = {}): Hono {
  const cache = new Map<string, Asset>();
  const app = new Hono();
  for (const [route, file] of Object.entries(ROUTES)) {
    app.get(route, (c) => {
      const asset = load(cache, dir, file);
      if (asset === undefined) return c.text(`${file} has not been built`, 404);
      const headers = { 'Cache-Control': CACHE_CONTROL, ETag: asset.etag, ...ALLOW_ORIGIN };
      if (ifNoneMatchHits(c.req.header('if-none-match'), asset.etag))
        return c.body(null, 304, headers);
      return c.body(asset.body, 200, { ...headers, 'Content-Type': CONTENT_TYPE });
    });
  }
  return app;
}

function load(cache: Map<string, Asset>, dir: string, file: string): Asset | undefined {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let body: string;
  try {
    body = readFileSync(join(dir, file), 'utf8');
  } catch {
    return undefined;
  }
  const asset: Asset = { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
  cache.set(file, asset);
  return asset;
}
