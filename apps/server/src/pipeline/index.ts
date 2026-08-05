import { type Hit, type HitContext, localClock } from '@featherstat/shared';
import { type Db, type EventRow, getSite } from '../db/index.ts';
import { type FlushHook, WriteBatcher } from './batcher.ts';
import { AliasCache } from './campaigns.ts';
import { isBotUserAgent, parseUserAgent, preferredLanguage } from './enrich.ts';
import { ExclusionMatcher, readExclusionRules } from './exclusions.ts';
import { type GeoProvider, NullProvider } from './geo.ts';
import { Identity } from './identity.ts';
import { PropRegistry } from './props.ts';
import { loadOpenSessions, priorSessionLookup, Sessionizer } from './sessionizer.ts';

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
  /** The live prop registry — the admin delete route invalidates through it. */
  props: PropRegistry;
  /** The live campaign-alias cache — the admin alias routes invalidate through it. */
  campaignAliases: AliasCache;
  /** The live exclusion set — the admin route replaces its rules, the refresh job resolves its hostnames. */
  exclusions: ExclusionMatcher;
}

/**
 * validate → exclusions → bot filter → UA parse → GeoIP → sessionize → batch
 * (docs/02). The raw IP is consumed by the exclusion check, the visitor hash and
 * the geo lookup, then discarded — never persisted, never logged (CLAUDE.md
 * invariant 3). The exclusion rules are the operator's own addresses, which is
 * configuration; no visitor address is stored by any of it.
 */
export function createPipeline(db: Db, options: PipelineOptions = {}): Pipeline {
  const geo = options.geo ?? new NullProvider();
  const identity = new Identity(db);
  const props = new PropRegistry(db);
  const batcher = new WriteBatcher(db, options.batchIntervalMs, props);
  // Every session row read back from the store is COMMITTED state: seed the
  // batcher's rollup snapshots before the sessionizer can mutate it, or the
  // next flush would book a revived visit as a brand-new one (docs/03 § Rollups).
  const lookup = priorSessionLookup(db);
  const campaignAliases = new AliasCache(db);
  // Literal rules bite immediately; hostname rules match once the refresh timer
  // main.ts starts has resolved them for the first time.
  const exclusions = new ExclusionMatcher();
  exclusions.setRules(readExclusionRules(db));
  const sessionizer = new Sessionizer((siteId, visitorId, notBefore) => {
    const prior = lookup(siteId, visitorId, notBefore);
    if (prior !== undefined) batcher.seedSnapshot(prior.row);
    return prior;
  }, campaignAliases.normalizer);
  const restored = loadOpenSessions(db, Date.now());
  for (const entry of restored) batcher.seedSnapshot(entry.row);
  sessionizer.restore(restored);
  batcher.onFlush(() => sessionizer.noteFlush());
  batcher.start();
  const hitHooks: HitHook[] = [];

  const sink: HitSink = (hits, ctx) => {
    // Exclusion runs before the bot check: it is one byte scan over a short list
    // and refusing here skips the UA parse and the geo lookup outright. A hit
    // that is both excluded and a crawler counts only as excluded — the
    // operator's own browser is the more useful thing to have been told.
    // `device` is null exactly when the hit is refused; all of this is
    // once-per-request work.
    const excluded = exclusions.matches(ctx.ip);
    const device = excluded || isBotUserAgent(ctx.userAgent) ? null : parseUserAgent(ctx.userAgent);
    const geoResult = device === null ? null : geo.lookup(ctx.ip);
    for (const hit of hits) {
      const site = getSite(db, hit.siteId);
      if (site === undefined) continue; // unknown site id → dropped, never 4xx (docs/04)
      if (device === null) {
        const localDate = localClock(site.timezone, ctx.receivedAt).date;
        if (excluded) batcher.addExcludedDrop(site.id, localDate);
        else batcher.addBotDrop(site.id, localDate);
        continue;
      }
      // Bag admission runs only when a bag exists — the hot path pays nothing
      // for hits without props (docs/03 § Props).
      const admitted =
        hit.props === undefined
          ? undefined
          : props.admit(
              site.id,
              hit.props,
              localClock(site.timezone, ctx.receivedAt).date,
              hit.type,
              ctx.receivedAt,
            );
      const sessionized = sessionizer.process({
        site,
        hit,
        visitorId: identity.visitorId(hit, ctx, site.timezone),
        now: ctx.receivedAt,
        device,
        geo: geoResult,
        lang: preferredLanguage(ctx.acceptLanguage, hit.lang),
        props: admitted,
      });
      if (sessionized === undefined) continue; // an orphan heartbeat: no visit to continue
      const { event, session } = sessionized;
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
    props,
    campaignAliases,
    exclusions,
  };
}
