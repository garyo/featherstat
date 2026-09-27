import { createHash } from 'node:crypto';
import { localClock, type SiteWindow } from '@featherstat/shared';

/**
 * ETag plumbing shared by every route that revalidates: the batch routes
 * (`/api/query`, `/share/:token`) hash the same inputs the same way, so the two
 * cannot disagree about what a tag covers.
 */

/**
 * `If-None-Match` uses the WEAK comparison (RFC 9110 § 13.1.2): `W/"x"` matches
 * `"x"`, because a cache or proxy may weaken a strong tag it forwards, and `*`
 * matches any current representation.
 */
export function ifNoneMatchHits(header: string | undefined, current: string): boolean {
  if (header === undefined) return false;
  const opaque = stripWeak(current);
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || stripWeak(tag) === opaque;
  });
}

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * The resolved windows as ETag input — the reason a preset expires on the site's
 * clock rather than on a data change. `today` moves at site-local midnight; the
 * rolling `24h` preset moves at every local hour turn and is stable in between,
 * which is exactly what its quantization buys (query/ranges.ts).
 *
 * The last component is where real data can stop inside the window —
 * `min(to, site-local today)`. Presets never need it (their dates move with the
 * clock already), but an explicit `from`/`to` range whose `to` is today or later
 * has static bounds over a moving clip: without this a dashboard left open
 * overnight would revalidate 304 forever while today's rows drained into a day
 * the cached body still shows empty. For a fully past range it equals `to`, so
 * those tags stay stable — exactly what makes them cacheable.
 */
export function windowTag(windows: readonly SiteWindow[], now: number): string {
  return windows
    .map((w) => {
      const today = localClock(w.timezone, now).date;
      const clip = w.to < today ? w.to : today;
      return `${w.siteId}:${w.timezone}:${w.from}:${w.to}:${w.fromTs ?? ''}:${w.toTs ?? ''}:${clip}`;
    })
    .join(',');
}

/** A strong tag over (data version, schema version, canonical body, windows). */
export function batchEtag(
  version: number,
  schema: number,
  canonicalBody: string,
  windows: readonly SiteWindow[],
  now: number,
): string {
  const hash = createHash('sha256')
    .update(`${version}|${schema}|${canonicalBody}|${windowTag(windows, now)}`)
    .digest('base64url');
  return `"${hash}"`;
}

/** JSON with object keys sorted, so key order alone can never produce a distinct ETag. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}
