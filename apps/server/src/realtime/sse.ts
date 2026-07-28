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
import type { RealtimeEntry, RealtimeHub } from './hub.ts';

/** docs/04 § 4: the comment that keeps proxies from reaping us. */
const HEARTBEAT_FRAME = ': keep-alive\n\n';
/**
 * Undelivered frames a connection may queue before it is dropped. A reader that
 * stalls without aborting (sleeping laptop, buffering proxy) must not grow an
 * in-memory queue at ingest rate; reconnect + `Last-Event-ID` recovers it.
 */
export const MAX_QUEUED_FRAMES = 1_000;

/** `?sites=1,4`; absent or `all` means every site. */
type SiteFilter = ReadonlySet<number> | undefined;

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
export function createRealtimeRoutes(hub: RealtimeHub): Hono {
  const app = new Hono();
  app.get('/api/realtime', (c) => {
    const sites = parseSites(c.req.query('sites'));
    if (sites === null) {
      return c.json({ error: "sites must be 'all' or a comma-separated list of site ids" }, 400);
    }
    const resumeFrom = parseEventId(c.req.header('last-event-id'));
    return streamSSE(c, async (stream) => {
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
      const recount = setInterval(
        () => send(frame('active', activeFrame(hub, sites))),
        ACTIVE_TICK_MS,
      );
      const heartbeat = setInterval(() => send(HEARTBEAT_FRAME), HEARTBEAT_MS);

      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(recount);
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  return app;
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
