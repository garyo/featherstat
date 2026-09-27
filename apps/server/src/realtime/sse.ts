import {
  ACTIVE_TICK_MS,
  HEARTBEAT_MS,
  type RealtimeActive,
  type RealtimeEngagement,
  RealtimeSitesSchema,
  type RealtimeSnapshot,
  SNAPSHOT_HITS,
} from '@featherstat/shared';
import { Hono } from 'hono';
import { type SSEMessage, type SSEStreamingApi, streamSSE } from 'hono/streaming';
import type { AuthVariables } from '../auth/auth.ts';
import { canReadSite, type Principal } from '../auth/principal.ts';
import type { RealtimeEntry, RealtimeHub } from './hub.ts';

/** docs/04 § 4: the comment that keeps proxies from reaping us. */
const HEARTBEAT_FRAME = ': keep-alive\n\n';
/**
 * Undelivered frames a connection may queue before it is dropped. A reader that
 * stalls without aborting (sleeping laptop, buffering proxy) must not grow an
 * in-memory queue at ingest rate; reconnect + `Last-Event-ID` recovers it.
 */
export const MAX_QUEUED_FRAMES = 1_000;

/**
 * Streams one principal may hold open at once. Every stream is a subscriber
 * the ingest path fans each hit out to, so a leaked token must not be able to
 * open thousands; a person's tabs never come near this.
 */
export const MAX_STREAMS_PER_PRINCIPAL = 16;

/** `?sites=1,4`; absent or `all` means every site. */
type SiteFilter = ReadonlySet<number> | undefined;

export interface RealtimeRouteOptions {
  /**
   * Re-reads the principal the gate resolved at connect (`Auth.refresh`). A
   * stream outlives its request, so on every `active` tick it asks again and
   * closes once the answer is gone or would scope it differently — a revoked
   * token, a logged-out session, a narrowed viewer. The client's reconnect
   * then meets the gate like any request.
   */
  refresh?: (principal: Principal) => Principal | undefined;
}

/**
 * `GET /api/realtime` (docs/04 § 4). One stream carries everything live: a
 * `snapshot` on connect, then `hit` per non-ping hit, `active` recounts, and a
 * `version` tick per site whose data landed — the signal that makes every
 * dashboard view live by default (docs/02, docs/05 R22). `snapshot` and
 * `active` both carry `visitors`: engaged time per alias, pings included.
 *
 * Only `hit` frames carry an `id:`, so a client's `Last-Event-ID` always names a
 * ring-buffer entry.
 */
export function createRealtimeRoutes(
  hub: RealtimeHub,
  options: RealtimeRouteOptions = {},
): Hono<{ Variables: Partial<AuthVariables> }> {
  const app = new Hono<{ Variables: Partial<AuthVariables> }>();
  const { refresh } = options;
  const streams = new StreamCounts(MAX_STREAMS_PER_PRINCIPAL);
  app.get('/api/realtime', (c) => {
    const requested = parseSites(c.req.query('sites'));
    if (requested === null) {
      return c.json({ error: "sites must be 'all' or a comma-separated list of site ids" }, 400);
    }
    const who = c.get('principal');
    const sites = streamSites(requested, who);
    const key = who === undefined ? undefined : streamKey(who);
    if (key !== undefined && !streams.acquire(key)) {
      return c.json({ error: 'too many open realtime streams' }, 429, { 'Retry-After': '60' });
    }
    const entitled = (): boolean => {
      if (who === undefined || refresh === undefined) return true;
      const current = refresh(who);
      return current !== undefined && sameSites(streamSites(requested, current), sites);
    };
    const resumeFrom = parseEventId(c.req.header('last-event-id'));
    return streamSSE(c, async (stream) => {
      try {
        const send = queuedWriter(stream);
        // Nothing awaits between the snapshot and `subscribe`, so a hit landing
        // right now lands in exactly one of them.
        send(frame('snapshot', snapshotFor(hub, sites, resumeFrom)));
        if (resumeFrom !== undefined) {
          for (const entry of hub.since(resumeFrom)) {
            if (covers(sites, entry.hit.siteId)) send(hitFrame(entry));
          }
        }

        const unsubscribe = hub.subscribe((message) => {
          if (message.kind === 'hit') {
            if (covers(sites, message.entry.hit.siteId)) send(hitFrame(message.entry));
          } else if (covers(sites, message.tick.siteId)) {
            send(frame('version', message.tick));
          }
        });
        let end = (): void => undefined;
        const ended = new Promise<void>((resolve) => {
          end = resolve;
          stream.onAbort(resolve);
        });
        const recount = setInterval(() => {
          if (entitled()) send(frame('active', activeFrame(hub, sites)));
          else end();
        }, ACTIVE_TICK_MS);
        const heartbeat = setInterval(() => send(HEARTBEAT_FRAME), HEARTBEAT_MS);

        await ended;
        clearInterval(recount);
        clearInterval(heartbeat);
        unsubscribe();
      } finally {
        if (key !== undefined) streams.release(key);
      }
    });
  });
  return app;
}

/**
 * The sites a principal's stream covers. A scoped principal's stream narrows to
 * its readable sites: `all` means "all of mine", and naming someone else's site
 * yields silence, not data.
 */
function streamSites(requested: SiteFilter, who: Principal | undefined): SiteFilter {
  if (who === undefined || who.kind === 'admin' || who.sites === 'all') return requested;
  return new Set([...(requested ?? who.sites)].filter((id) => canReadSite(who, id)));
}

function sameSites(a: SiteFilter, b: SiteFilter): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** Open streams per key, refusing past a cap. */
class StreamCounts {
  private readonly open = new Map<string, number>();

  constructor(private readonly cap: number) {}

  acquire(key: string): boolean {
    const count = this.open.get(key) ?? 0;
    if (count >= this.cap) return false;
    this.open.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const left = (this.open.get(key) ?? 1) - 1;
    if (left > 0) this.open.set(key, left);
    else this.open.delete(key);
  }
}

/** One budget per session or token — the unit a revocation or a leak concerns. */
function streamKey(who: Principal): string {
  return who.kind === 'token' ? `token:${who.tokenId}` : `session:${who.sessionId}`;
}

/**
 * Frames are queued and never awaited by the caller: a stalled reader must not
 * block ingest or any other subscriber. Chaining keeps them in emission order;
 * a reader that falls `MAX_QUEUED_FRAMES` behind is aborted, so the queue can
 * never grow without bound.
 */
function queuedWriter(stream: SSEStreamingApi): (message: SSEMessage | string) => void {
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  return (message) => {
    if (stream.aborted) return;
    if (queued >= MAX_QUEUED_FRAMES) {
      stream.abort(); // triggers the route's onAbort cleanup
      return;
    }
    queued += 1;
    chain = chain
      .then(async () => {
        if (typeof message === 'string') await stream.write(message);
        else await stream.writeSSE(message);
      })
      .catch(() => undefined) // a dead stream is a disconnect, not an error
      .finally(() => {
        queued -= 1;
      });
  };
}

function snapshotFor(
  hub: RealtimeHub,
  sites: SiteFilter,
  resumeFrom: number | undefined,
): RealtimeSnapshot {
  // A resuming client gets its missed hits as `hit` frames instead; sending the
  // last 50 as well would double-deliver them.
  const recent =
    resumeFrom === undefined ? hub.recent(SNAPSHOT_HITS, (hit) => covers(sites, hit.siteId)) : [];
  return { ...activeFrame(hub, sites), recent };
}

/** The `active` recount, and the head of every snapshot: counts plus engaged time. */
function activeFrame(hub: RealtimeHub, sites: SiteFilter): RealtimeActive {
  return { active: activeFor(hub, sites), visitors: visitorsFor(hub, sites) };
}

function activeFor(hub: RealtimeHub, sites: SiteFilter): Record<number, number> {
  const counts = hub.activeCounts();
  if (sites === undefined) return counts;
  const active: Record<number, number> = {};
  for (const siteId of sites) {
    const count = counts[siteId];
    if (count !== undefined) active[siteId] = count;
  }
  return active;
}

function visitorsFor(hub: RealtimeHub, sites: SiteFilter): RealtimeEngagement[] {
  return hub.visitors().filter((entry) => covers(sites, entry.siteId));
}

function hitFrame(entry: RealtimeEntry): SSEMessage {
  return { event: 'hit', id: String(entry.id), data: JSON.stringify(entry.hit) };
}

function frame(event: string, data: unknown): SSEMessage {
  return { event, data: JSON.stringify(data) };
}

function covers(sites: SiteFilter, siteId: number): boolean {
  return sites === undefined || sites.has(siteId);
}

/** Absent or `all` = every site; malformed is `null` (a 400), never a wider subscription. */
function parseSites(raw: string | undefined): SiteFilter | null {
  if (raw === undefined) return undefined;
  const parsed = RealtimeSitesSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data === 'all' ? undefined : new Set(parsed.data);
}

function parseEventId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}
