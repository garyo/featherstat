import type { Hit, HitContext } from '@featherstat/shared';
import type { HitSink } from './index.ts';

/**
 * Tee mode (docs/06): a HitSink decorator that delivers every hit to the real
 * sink first, then re-serializes it to matomo.php query-string form and POSTs
 * it fire-and-forget to the live Matomo in bulk format — with the original
 * client IP as `cip` and the configured `token_auth`, so Matomo attributes it
 * correctly during the bake.
 *
 * Forwarding must NEVER slow or block local ingest: the local sink runs
 * synchronously before anything else, POSTs are bounded (`maxInFlight`), the
 * backlog is bounded (`maxPending`, drop-oldest), and drops/failures are
 * counted, not raised.
 */

export interface TeeOptions {
  /** The live Matomo endpoint, e.g. https://matomo.example.com/matomo.php */
  forwardUrl: string;
  /** Matomo API token; required by Matomo to honor `cip`/`cdt`. */
  tokenAuth?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<unknown>;
  /** Queued payloads beyond the in-flight ones; oldest dropped past this. */
  maxPending?: number;
  /** Concurrent forward POSTs. */
  maxInFlight?: number;
}

interface TeeStats {
  forwarded: number;
  dropped: number;
  failed: number;
  pending: number;
}

export interface TeeSink {
  sink: HitSink;
  stats(): TeeStats;
}

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_IN_FLIGHT = 4;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function createTeeSink(inner: HitSink, options: TeeOptions): TeeSink {
  const fetchFn = options.fetchFn ?? fetch;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const queue: string[] = [];
  let inFlight = 0;
  let forwarded = 0;
  let dropped = 0;
  let failed = 0;

  const pump = (): void => {
    while (inFlight < maxInFlight) {
      const body = queue.shift();
      if (body === undefined) return;
      inFlight += 1;
      // Deferred to a microtask so even a misbehaving fetch cannot stall the caller.
      Promise.resolve()
        .then(() => fetchFn(options.forwardUrl, { method: 'POST', headers: JSON_HEADERS, body }))
        .then(
          (result) => {
            // A Matomo answering 403 (bad token) must not read as 100% forwarded.
            if (isNotOk(result)) failed += 1;
            else forwarded += 1;
          },
          () => {
            failed += 1;
          },
        )
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  const sink: HitSink = (hits, ctx) => {
    inner(hits, ctx); // local ingest first, always, synchronously
    queue.push(bulkBody(hits, ctx, options.tokenAuth));
    while (queue.length > maxPending) {
      queue.shift();
      dropped += 1;
    }
    pump();
  };

  return {
    sink,
    stats: () => ({ forwarded, dropped, failed, pending: queue.length + inFlight }),
  };
}

/** Duck-typed `Response.ok` check — injected test fetches return plain objects. */
function isNotOk(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok: unknown }).ok === false
  );
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Convenience for the integrator: tee only when MATOMO_FORWARD_URL is set. */
export function teeSinkFromEnv(
  inner: HitSink,
  env: NodeJS.ProcessEnv = process.env,
): TeeSink | undefined {
  const forwardUrl = env.MATOMO_FORWARD_URL;
  if (!forwardUrl) return undefined;
  // token_auth travels in the bulk body: plain http would put a full-privilege
  // Matomo token on the wire. Loopback (docker-network tunnels) is exempt.
  const url = new URL(forwardUrl);
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('MATOMO_FORWARD_URL must be https (or loopback) — it carries token_auth');
  }
  return createTeeSink(inner, { forwardUrl, tokenAuth: env.MATOMO_TOKEN_AUTH });
}

/** Matomo bulk format: one request string per hit of the original request. */
function bulkBody(hits: readonly Hit[], ctx: HitContext, tokenAuth: string | undefined): string {
  const body: { requests: string[]; token_auth?: string } = {
    requests: hits.map((hit) => serializeHit(hit, ctx, tokenAuth !== undefined)),
  };
  // Bulk-level only: Matomo honors it for every request in the batch, and the
  // per-request strings routinely end up in logs — no token copies there.
  if (tokenAuth !== undefined) body.token_auth = tokenAuth;
  return JSON.stringify(body);
}

/**
 * A normalized Hit back to the matomo.php params it came from (docs/04 § 1),
 * plus what Matomo needs to record it as the original request: `cip` (client
 * IP — the sender's own override wins, e.g. a server-side webhook), `cdt`
 * (original receive time) and `ua`; the bulk-level `token_auth` authorizes them.
 */
function serializeHit(hit: Hit, ctx: HitContext, authorized: boolean): string {
  const params = new URLSearchParams();
  params.set('idsite', String(hit.siteId));
  params.set('rec', '1');
  if (hit.url !== undefined) params.set('url', hit.url);
  if (hit.title !== undefined) params.set('action_name', hit.title);
  if (hit.referrer !== undefined) params.set('urlref', hit.referrer);
  switch (hit.type) {
    case 'event': {
      if (hit.event !== undefined) {
        params.set('e_c', hit.event.category);
        params.set('e_a', hit.event.action);
        if (hit.event.name !== undefined) params.set('e_n', hit.event.name);
        if (hit.event.value !== undefined) params.set('e_v', String(hit.event.value));
      }
      break;
    }
    case 'outlink':
      if (hit.targetUrl !== undefined) params.set('link', hit.targetUrl);
      break;
    case 'download':
      if (hit.targetUrl !== undefined) params.set('download', hit.targetUrl);
      break;
    case 'ping':
      params.set('ping', '1');
      break;
    case 'pageview':
      break;
  }
  if (hit.screen !== undefined) params.set('res', hit.screen);
  if (hit.lang !== undefined) params.set('lang', hit.lang);
  if (hit.visitorId !== undefined) params.set('_id', hit.visitorId);
  if (hit.uid !== undefined) params.set('uid', hit.uid);
  if (ctx.userAgent !== '') params.set('ua', ctx.userAgent);
  params.set('cdt', String(Math.floor(ctx.receivedAt / 1000)));
  // Matomo does not merely ignore an unauthorized cip — it invalidates the
  // whole request inside an HTTP 200 (verified against Matomo 5.4 during the
  // reference cutover). Without a token, forwarding without cip loses only
  // Matomo-side geo, not the hit.
  if (authorized) params.set('cip', hit.clientIpOverride ?? ctx.ip);
  return `?${params.toString()}`;
}
