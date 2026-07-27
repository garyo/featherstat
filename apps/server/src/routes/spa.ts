import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Hono } from 'hono';

/**
 * Serves the built dashboard (`apps/web/dist`) from the bundled server — the
 * Docker image is one process serving SPA, API and trackers (docs/02 § Shape).
 * Mounted last: every registered route wins over this catch-all.
 *
 * Files are read once and held in memory: the bundle is small and immutable
 * for the life of a container. Vite's hashed `/assets/*` get immutable caching;
 * everything else (index.html above all) revalidates by ETag.
 */

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export interface Asset {
  body: Buffer;
  type: string;
  etag: string;
  cacheControl: string;
}

export interface SpaRoutesOptions {
  /** The built SPA — a directory containing index.html. */
  dir: string;
}

export function createSpaRoutes({ dir }: SpaRoutesOptions): Hono {
  const cache = createAssetCache(resolve(dir));
  const app = new Hono();

  app.get('*', (c) => {
    const pathname = safePathname(c.req.url);
    if (pathname === undefined) return c.notFound();
    const asset = cache.get(pathname);
    if (asset === undefined) return c.notFound();
    const headers = { 'Cache-Control': asset.cacheControl, ETag: asset.etag };
    if (matches(c.req.header('if-none-match'), asset.etag)) return c.body(null, 304, headers);
    return c.body(bodyOf(asset), 200, { ...headers, 'Content-Type': asset.type });
  });

  return app;
}

export interface AssetCache {
  get(pathname: string): Asset | undefined;
  /** Cached entries — bounded by the number of real files in the bundle. */
  size(): number;
}

/**
 * Only paths that resolve to a REAL file become cache keys — the bundle bounds
 * the map. Navigation paths (attacker-chosen, unbounded) all share the single
 * `/index.html` entry, and misses are answered from disk (a cheap failed stat),
 * never remembered.
 */
export function createAssetCache(root: string): AssetCache {
  const assets = new Map<string, Asset>();
  const get = (pathname: string): Asset | undefined => {
    const cached = assets.get(pathname);
    if (cached !== undefined) return cached;
    const asset = load(root, pathname);
    if (asset !== undefined) {
      assets.set(pathname, asset);
      return asset;
    }
    // Navigation paths (no extension) fall back to index.html — the SPA owns them.
    if (extname(pathname) !== '' || pathname === '/index.html') return undefined;
    return get('/index.html');
  };
  return { get, size: () => assets.size };
}

function load(root: string, pathname: string): Asset | undefined {
  const file = resolve(join(root, `.${pathname}`));
  if (file !== root && !file.startsWith(root + sep)) return undefined; // no traversal
  let body: Buffer;
  try {
    body = readFileSync(pathname === '/' ? join(root, 'index.html') : file);
  } catch {
    return undefined;
  }
  const ext = pathname === '/' ? '.html' : extname(file);
  const type = CONTENT_TYPES[ext];
  if (type === undefined) return undefined;
  return {
    body,
    type,
    etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    cacheControl: pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE,
  };
}

/** Decoded and normalized, or undefined for anything malformed. */
function safePathname(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0') || pathname.includes('..')) return undefined;
  return pathname;
}

function bodyOf(asset: Asset): ArrayBuffer {
  return asset.body.buffer.slice(
    asset.body.byteOffset,
    asset.body.byteOffset + asset.body.byteLength,
  ) as ArrayBuffer;
}

function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag);
}
