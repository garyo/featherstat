import type { SiteRef, UnknownSiteReport } from '@featherstat/shared';

/** Distinct references held; past it the longest-unseen one is forgotten (its hits still count). */
export const UNKNOWN_SITE_REFS = 20;

/**
 * Hits that named no site (docs/04 § 2), counted since boot for the diagnostics
 * panel. A beacon for an unknown site is answered and dropped — invariant 4 —
 * so without this a mistyped domain in a snippet is invisible.
 *
 * In memory on purpose: a forged beacon can name anything, so nothing it says
 * is written down, and the reference list is bounded however many it names.
 */
export class UnknownSiteTally {
  private hits = 0;
  /** Insertion order is recency: a sighting moves its entry to the end. */
  private readonly refs = new Map<string, { hits: number; lastSeen: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly since: number = now(),
  ) {}

  record(ref: SiteRef, hits: number): void {
    if (hits <= 0) return;
    this.hits += hits;
    const key = String(ref);
    const prior = this.refs.get(key);
    this.refs.delete(key);
    this.refs.set(key, { hits: (prior?.hits ?? 0) + hits, lastSeen: this.now() });
    if (this.refs.size > UNKNOWN_SITE_REFS) {
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
  }

  report(): UnknownSiteReport {
    const recent = [...this.refs].reverse().map(([ref, entry]) => ({ ref, ...entry }));
    return { since: this.since, hits: this.hits, recent };
  }
}
