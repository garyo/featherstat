import type { RealtimeHit } from '@featherstat/shared';
import type { SiteScope } from './state.ts';

/**
 * Pure shaping for the Realtime view: the live feed and its 30-minute country
 * tally, both fed straight from the SSE stream — no queries (docs/05).
 */

/** Rows the feed keeps in memory; also bounds the tally's input. */
export const FEED_KEEP = 100;
/** Rows the feed shows. */
export const FEED_SHOW = 30;
export const TALLY_WINDOW_MS = 30 * 60_000;
export const TALLY_ROWS = 8;
/** Per-visitor tally rows shown under the active-now hero. */
export const VISITOR_ROWS = 8;

export function inScope(hit: RealtimeHit, site: SiteScope): boolean {
  return site === 'all' || hit.siteId === site;
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
  /** The per-day alias — the visitor's identity here (docs/03 § Visitor identity). */
  name: string;
  /** Categorical palette index from the alias; cycling tokens is fine — see shared/alias. */
  color: number;
  count: number;
  /** Newest located hit's city, else its country code; undefined when never located. */
  city?: string;
  country?: string;
}

/**
 * Hits inside the window grouped by visitor alias, most hits first (ties by
 * name), capped at `VISITOR_ROWS`. Expects the feed's newest-first order, so
 * the first geo seen per visitor is their latest.
 */
export function visitorTally(
  hits: readonly RealtimeHit[],
  now: number,
  windowMs = TALLY_WINDOW_MS,
): VisitorCount[] {
  const byName = new Map<string, VisitorCount>();
  for (const hit of hits) {
    if (now - hit.ts > windowMs) continue;
    let row = byName.get(hit.visitor.name);
    if (row === undefined) {
      row = { name: hit.visitor.name, color: hit.visitor.color, count: 0 };
      byName.set(row.name, row);
    }
    row.count += 1;
    // First LOCATED hit wins (the newest, given the order) — an unlocated one
    // must not blank a visitor an older hit can still place.
    if (row.city === undefined && row.country === undefined && hit.country !== undefined) {
      row.city = hit.city;
      row.country = hit.country;
    }
  }
  const rows = [...byName.values()];
  rows.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return rows.slice(0, VISITOR_ROWS);
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
