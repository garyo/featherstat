import type { HitContext } from '@featherstat/shared';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { parseMatomoRequest } from '../ingest/matomo.ts';
import { parseCollectRequest } from '../ingest/native.ts';
import type { HitSink } from '../pipeline/index.ts';

const TRACKING_PATHS = ['/matomo.php', '/piwik.php'];
const COLLECT_PATH = '/api/collect';

/**
 * The collector is reached cross-origin from every tracked site. `send.ts`
 * keeps its beacons CORS-safelisted (a `text/plain` body, a `no-cors` fetch
 * fallback) so nothing here is load-bearing for the trackers — it is what lets
 * a hand-rolled `fetch` sender work without one (docs/04 § 2).
 */
const COLLECT_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};

const TRACKING_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (char) => char.charCodeAt(0),
).buffer as ArrayBuffer;

const GIF_HEADERS = { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' };
const EMPTY_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * Matomo bulk bodies are small (a page of beacons); anything bigger is abuse.
 * Oversized bodies are DISCARDED, never rejected — the query string is still
 * parsed and the response stays 204/GIF (CLAUDE.md invariant 4).
 */
export const MAX_TRACK_BODY_BYTES = 256 * 1024;

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
    // Hono answers HEAD from the GET route. A HEAD is a probe — an uptime check,
    // a link unfurler — never a beacon: it gets the GET's answer and records nothing.
    if (hits.length > 0 && c.req.method !== 'HEAD') sink(hits, hitContext(c));
    return sendImage ? c.body(TRACKING_GIF, 200, GIF_HEADERS) : c.body(null, 204, EMPTY_HEADERS);
  });

  // The native collector (docs/04 § 2). Same sink, same context, same promise:
  // it answers 204 whether it understood the body or not (invariant 4).
  app.post(COLLECT_PATH, async (c) => {
    const hits = parseCollectRequest(await readBody(c));
    if (hits.length > 0) sink(hits, hitContext(c));
    return c.body(null, 204, { ...EMPTY_HEADERS, ...COLLECT_CORS_HEADERS });
  });
  app.options(COLLECT_PATH, (c) => c.body(null, 204, COLLECT_CORS_HEADERS));
  return app;
}

/** Streams the body up to the cap; past it (or on any read error) → undefined. */
async function readBody(c: Context, maxBytes = MAX_TRACK_BODY_BYTES): Promise<string | undefined> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  const stream = c.req.raw.body;
  if (stream === null) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.byteLength;
      if (total > maxBytes) return undefined; // breaking the loop cancels the stream
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function hitContext(c: Context): HitContext {
  return {
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    acceptLanguage: c.req.header('accept-language'),
    receivedAt: Date.now(),
  };
}

/**
 * How many trusted reverse proxies stand in front of this server (each appends
 * one `X-Forwarded-For` entry). Default 1 — the documented Traefik deployment.
 * 0 = no proxy: forwarded headers are attacker-supplied and ignored entirely.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

const DEFAULT_HOPS = trustedProxyHops();

/**
 * The client address, spoof-resistant: a proxy APPENDS the peer it saw, so the
 * only trustworthy `X-Forwarded-For` entry is the one `hops` from the end —
 * element 0 is whatever the client typed. Fewer entries than trusted hops means
 * the request did not traverse the proxy chain; fall back to the socket peer
 * rather than trusting any remaining entry.
 */
export function clientIp(c: Context, hops: number = DEFAULT_HOPS): string {
  if (hops > 0) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded !== undefined) {
      const entries = forwarded
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      const trusted = entries[entries.length - hops];
      if (trusted !== undefined) return trusted;
    } else {
      const realIp = c.req.header('x-real-ip');
      if (realIp !== undefined && realIp !== '') return realIp;
    }
  }
  return socketAddress(c);
}

function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return ''; // no node socket behind this request (tests via app.request)
  }
}
