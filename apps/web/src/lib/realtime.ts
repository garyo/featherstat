import { type RealtimeEngagement, type RealtimeHit, TALLY_WINDOW_MS } from '@featherstat/shared';
import type { BarRow } from '../widgets/bar-rows.ts';
import { displayDuration } from '../widgets/format.ts';
import { countryName } from '../widgets/geo.ts';
import type { RealtimeEnv } from '../widgets/types.ts';
import type { SiteScope } from './state.ts';

/**
 * Pure shaping for the Realtime view: the live feed and its 30-minute country
 * tally, both fed straight from the SSE stream — no queries (docs/05).
 */

/** Rows the feed keeps in memory; also bounds the tally's input. */
export const FEED_KEEP = 100;
/** Rows the feed shows. */
export const FEED_SHOW = 30;
export const TALLY_ROWS = 8;
/** Per-visitor tally rows shown under the active-now hero. */
export const VISITOR_ROWS = 8;

/** Anything the stream scopes by site: a hit, an engagement row. */
export function inScope(entry: { siteId: number }, site: SiteScope): boolean {
  return site === 'all' || entry.siteId === site;
}

/**
 * The feed rows a scope shows. Every realtime widget starts here, so a page
 * without the stream (a share link) yields nothing to render rather than each
 * widget re-deciding what `no stream` looks like.
 */
export function scopedHits(realtime: RealtimeEnv | null, site: SiteScope): readonly RealtimeHit[] {
  return realtime === null ? [] : realtime.recent.filter((hit) => inScope(hit, site));
}

/**
 * The active-now hero: the server's distinct-visitor count for this scope,
 * summed across sites at 'all'. It reads the stream's counts and never the feed
 * — hits carry no visitor id (CLAUDE.md invariant 3).
 */
export function activeCount(realtime: RealtimeEnv | null, site: SiteScope): number {
  if (realtime === null) return 0;
  return site === 'all'
    ? Object.values(realtime.active).reduce((sum, n) => sum + n, 0)
    : (realtime.active[site] ?? 0);
}

/** Newest first, capped — snapshot `recent` arrives oldest first. */
export function seedFeed(recent: readonly RealtimeHit[], site: SiteScope): RealtimeHit[] {
  const scoped = recent.filter((hit) => inScope(hit, site));
  return scoped.slice(-FEED_KEEP).reverse();
}

export function pushFeed(feed: readonly RealtimeHit[], hit: RealtimeHit): RealtimeHit[] {
  return [hit, ...feed.slice(0, FEED_KEEP - 1)];
}

/** `8s`, `4m`, `2h` — the feed's relative timestamp; sub-second is `now`. */
export function relativeAgo(ts: number, now: number): string {
  const seconds = Math.floor((now - ts) / 1000);
  if (seconds < 1) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export interface CountryCount {
  country: string;
  count: number;
  /** Share of the leading country, 0–100 with one decimal — the inline bar width. */
  pct: string;
}

export interface VisitorCount {
  /** The opaque handle rows and trails are keyed by; the name is display only. */
  ref: string;
  /** The per-day alias — the visitor's identity here (docs/03 § Visitor identity). */
  name: string;
  /** Categorical palette index from the alias; cycling tokens is fine — see shared/alias. */
  color: number;
  count: number;
  /** Newest hit's site — the badge when the realtime scope is 'all'. */
  siteId: number;
  /** Newest located hit's city, else its country code; undefined when never located. */
  city?: string;
  region?: string;
  country?: string;
  /** Engaged time in this visitor's current session; absent until they have some. */
  engagedMs?: number;
}

/**
 * Engaged time by alias — what the tally merges in. Summed across a visitor's
 * sites when the scope is 'all', exactly as their hit counts already are.
 *
 * Only visitors with time on the clock appear: a row whose visit is one instant
 * old should read `1 hit`, not `1 hit · 0s`.
 */
/**
 * The visitor's identity on this wire: the server's opaque per-process ref.
 * The alias name is a LABEL — 384 of them for any number of visitors — so it
 * groups nothing. Keying by name merged strangers into one row with an
 * interleaved trail; keying by ref cannot, and stays exact even when two
 * visitors draw the same name (they then read alike and behave apart).
 */
export function visitorKey(visitor: { ref: string }): string {
  return visitor.ref;
}

export function engagementByName(
  entries: readonly RealtimeEngagement[],
  site: SiteScope,
): Map<string, number> {
  const byName = new Map<string, number>();
  for (const entry of entries) {
    if (entry.engagedMs <= 0 || !inScope(entry, site)) continue;
    const key = visitorKey(entry);
    byName.set(key, (byName.get(key) ?? 0) + entry.engagedMs);
  }
  return byName;
}

/**
 * Hits inside the window grouped by visitor alias, most hits first (ties by
 * name), capped at `VISITOR_ROWS`. Expects the feed's newest-first order, so
 * the first geo seen per visitor is their latest.
 *
 * Engaged time is the server's (the browser never sees the pings that make it
 * honest); it joins by alias, the only visitor key either side has.
 */
export function visitorTally(
  hits: readonly RealtimeHit[],
  now: number,
  engagement: ReadonlyMap<string, number> = new Map(),
  windowMs = TALLY_WINDOW_MS,
): VisitorCount[] {
  const byName = new Map<string, VisitorCount>();
  for (const hit of hits) {
    if (now - hit.ts > windowMs) continue;
    const key = visitorKey(hit.visitor);
    let row = byName.get(key);
    if (row === undefined) {
      row = {
        ref: hit.visitor.ref,
        name: hit.visitor.name,
        color: hit.visitor.color,
        siteId: hit.siteId,
        count: 0,
        engagedMs: engagement.get(key),
      };
      byName.set(key, row);
    }
    row.count += 1;
    // First LOCATED hit wins (the newest, given the order) — an unlocated one
    // must not blank a visitor an older hit can still place.
    if (row.city === undefined && row.country === undefined && hit.country !== undefined) {
      row.city = hit.city;
      row.region = hit.region;
      row.country = hit.country;
    }
  }
  const rows = [...byName.values()];
  rows.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return rows.slice(0, VISITOR_ROWS);
}

/**
 * Who is here, as the tally shows them: the scope's hits grouped by visitor with
 * the server's engaged time folded in. One call, so a page cannot show the
 * visitors and lose their durations — which is what a dashboard did for as long
 * as the feed and the engagement rows were separate props.
 */
export function visitorRows(
  realtime: RealtimeEnv | null,
  site: SiteScope,
  now: number,
): VisitorCount[] {
  if (realtime === null) return [];
  return visitorTally(
    scopedHits(realtime, site),
    now,
    engagementByName(realtime.visitorTimes, site),
  );
}

/**
 * A tally row's trailing detail: `3 hits · 2m 40s · Masterton, NZ · deep-timeline.org`.
 * Segments the row has nothing to say about are dropped, never rendered empty.
 */
export function visitorMeta(row: VisitorCount, place?: string, siteName?: string): string {
  const parts = [`${row.count} ${row.count === 1 ? 'hit' : 'hits'}`];
  const spent = displayDuration(row.engagedMs);
  if (spent !== undefined) parts.push(spent);
  if (place !== undefined) parts.push(place);
  if (siteName !== undefined) parts.push(siteName);
  return parts.join(' · ');
}

/** Hits inside the window, counted by country, unknown geo skipped, ties by code. */
export function countryTally(
  hits: readonly RealtimeHit[],
  now: number,
  windowMs = TALLY_WINDOW_MS,
): CountryCount[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    if (hit.country === undefined || now - hit.ts > windowMs) continue;
    counts.set(hit.country, (counts.get(hit.country) ?? 0) + 1);
  }
  const list = [...counts.entries()].map(([country, count]) => ({ country, count }));
  list.sort((a, b) => b.count - a.count || (a.country < b.country ? -1 : 1));
  const max = Math.max(1, list[0]?.count ?? 0);
  return list
    .slice(0, TALLY_ROWS)
    .map((row) => ({ ...row, pct: ((row.count / max) * 100).toFixed(1) }));
}

/**
 * Where subdivisions are how people write an address: `Wake Forest, NC` reads
 * as a place, while `Exeter, Devon` is noise next to `Exeter, GB`.
 */
const REGION_AS_PLACE = new Set(['US', 'CA']);

/** A hit's place, as the feed prints it: `City, NC` or `City, CC`, else the country, else Unknown. */
export function placeOf(place: {
  city?: string | undefined;
  region?: string | undefined;
  country?: string | undefined;
}): string | undefined {
  if (place.city !== undefined && place.country !== undefined) {
    const region = REGION_AS_PLACE.has(place.country) ? place.region : undefined;
    return `${place.city}, ${region ?? place.country}`;
  }
  if (place.city !== undefined) return place.city;
  return place.country !== undefined ? countryName(place.country) : undefined;
}

/** The same place, for a row that must print something rather than omit it. */
export function placeLabel(hit: RealtimeHit): string {
  return placeOf(hit) ?? 'Unknown';
}

/** What the visitor did: an event reads `category · action`, anything else its path. */
export function actionLabel(hit: RealtimeHit): string {
  if (hit.type !== 'event') return hit.path ?? '/';
  const action = hit.eventAction ?? 'event';
  return hit.eventCategory !== undefined ? `${hit.eventCategory} · ${action}` : action;
}

/** One step of a visitor's trail: what they did, when, and how deep in they were. */
export interface TrailStep {
  ts: number;
  label: string;
  isEvent: boolean;
  engagedMs?: number;
}

/**
 * A visitor's recent path through the site, oldest first — the ring already
 * holds it, so expanding a tally row costs no query (docs/05: the realtime
 * surface answers from the stream alone). Capped so one busy visitor cannot
 * unroll the whole card.
 */
export function visitorTrail(
  hits: readonly RealtimeHit[],
  row: Pick<VisitorCount, 'ref'>,
  now: number,
  windowMs = TALLY_WINDOW_MS,
  limit = TRAIL_STEPS,
): TrailStep[] {
  const steps: TrailStep[] = [];
  for (const hit of hits) {
    // The same window the row's own counts use — a trail longer than the row
    // says 'N hits' is the tell that they disagree about who or when.
    if (now - hit.ts > windowMs) continue;
    if (hit.visitor.ref !== row.ref) continue;
    steps.push({
      ts: hit.ts,
      label: actionLabel(hit),
      isEvent: hit.type === 'event',
      engagedMs: hit.engagedMs,
    });
    if (steps.length >= limit) break;
  }
  // Newest first, like the feed above it.
  return steps;
}

export const TRAIL_STEPS = 12;

/** The country tally as bar rows — the shared bar renderer takes it from here. */
export function countryRows(counts: readonly CountryCount[]): BarRow[] {
  return counts.map((row) => ({
    name: row.country,
    value: row.count,
    extra: 0,
    pct: row.pct,
    // Realtime is stream-shaped, not query-shaped: there is nothing to filter into.
    filterValue: undefined,
  }));
}
