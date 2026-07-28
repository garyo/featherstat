import { createHash } from 'node:crypto';
import { aliasFromDigest, DAY_MS, type RealtimeVisitor } from '@featherstat/shared';

/**
 * The realtime alias for a hit: `sha256(UTC day ∥ visitor_id)` mapped onto the
 * shared word lists (docs/03 § Visitor identity). One-way — the digest never
 * carries the visitor id forward, and only three of its bytes reach the wire
 * as a word choice.
 *
 * The day input is load-bearing, not decoration: fingerprint-derived visitor
 * ids already rotate with the day salt, but `_id`- and `uid`-derived ones are
 * stable across days, and the alias must still reset at 00:00 UTC.
 *
 * The day is forward-only, like `Identity.currentDaySalt`: a backward clock
 * step across midnight keeps the current day, so the alias stays keyed to the
 * same day as the salt and one visitor cannot split into two names mid-day.
 */
export class VisitorAliaser {
  private day = -1;

  alias(visitorId: Uint8Array, ts: number): RealtimeVisitor {
    const day = Math.floor(ts / DAY_MS);
    if (day > this.day) this.day = day;
    return aliasFromDigest(createHash('sha256').update(`${this.day}\n`).update(visitorId).digest());
  }
}
