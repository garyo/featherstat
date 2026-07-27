import type { Hit, HitContext } from '@analytics/shared';
import { type Db, type EventRow, getSite } from '../db/index.ts';
import { type FlushHook, WriteBatcher } from './batcher.ts';
import { isBotUserAgent, parseUserAgent, preferredLanguage } from './enrich.ts';
import { type GeoProvider, NullProvider } from './geo.ts';
import { Identity } from './identity.ts';
import { loadOpenSessions, localParts, Sessionizer } from './sessionizer.ts';

/** Where normalized hits go. `createPipeline` builds the real one; routes call it. */
export type HitSink = (hits: Hit[], ctx: HitContext) => void;

/** Enriched hit, delivered as it happens — the realtime hub cannot wait for the flush. */
export type HitHook = (event: EventRow) => void;

export interface PipelineOptions {
  geo?: GeoProvider;
  batchIntervalMs?: number;
}

export interface Pipeline {
  sink: HitSink;
  /** Flushes everything queued right now (tests, admin). */
  flush(): void;
  /** Stops the batch timer and flushes — wire to SIGTERM/SIGINT. */
  shutdown(): void;
  onHit(hook: HitHook): void;
  onFlush(hook: FlushHook): void;
}

/**
 * validate → bot filter → UA parse → GeoIP → sessionize → batch (docs/02).
 * The raw IP is consumed by the visitor hash and the geo lookup, then
 * discarded — never persisted, never logged (CLAUDE.md invariant 3).
 */
export function createPipeline(db: Db, options: PipelineOptions = {}): Pipeline {
  const geo = options.geo ?? new NullProvider();
  const identity = new Identity(db);
  const sessionizer = new Sessionizer();
  sessionizer.restore(loadOpenSessions(db, Date.now()));
  const batcher = new WriteBatcher(db, options.batchIntervalMs);
  batcher.start();
  const hitHooks: HitHook[] = [];

  const sink: HitSink = (hits, ctx) => {
    // `device` is null exactly when the UA is a bot; both are once-per-request work.
    const device = isBotUserAgent(ctx.userAgent) ? null : parseUserAgent(ctx.userAgent);
    const geoResult = device === null ? null : geo.lookup(ctx.ip);
    for (const hit of hits) {
      const site = getSite(db, hit.siteId);
      if (site === undefined) continue; // unknown site id → dropped, never 4xx (docs/04)
      if (device === null) {
        batcher.addBotDrop(site.id, localParts(site.timezone, ctx.receivedAt).date);
        continue;
      }
      const { event, session } = sessionizer.process({
        site,
        hit,
        visitorId: identity.visitorId(hit, ctx),
        now: ctx.receivedAt,
        device,
        geo: geoResult,
        lang: preferredLanguage(ctx.acceptLanguage, hit.lang),
      });
      batcher.addEvent(event);
      batcher.addSession(session);
      for (const hook of hitHooks) hook(event);
    }
  };

  return {
    sink,
    flush: () => {
      batcher.flush();
    },
    shutdown: () => batcher.stop(),
    onHit: (hook) => {
      hitHooks.push(hook);
    },
    onFlush: (hook) => batcher.onFlush(hook),
  };
}
