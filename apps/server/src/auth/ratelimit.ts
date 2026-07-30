/**
 * In-memory sliding-window rate limiter (docs/02 § Security posture). Keys are
 * client IPs or session ids held transiently in memory — never persisted, never
 * logged (CLAUDE.md invariant 3).
 *
 * Two ways to spend a budget, and the difference matters:
 *
 * - `allow` charges the ATTEMPT. Right for login and for share links, where the
 *   attempt itself is the thing being limited and a caller that keeps knocking
 *   should stay locked out.
 * - `exhausted` + `charge` charge the WORK. Right for `/api/query`, where a
 *   refused request costs nothing and a dashboard reconnecting every few seconds
 *   would otherwise hold its own lockout open forever — a false positive that
 *   never recovers is worse than the burst it was protecting against.
 */

const PRUNE_EVERY_MS = 60_000;
/** Longer than any real address — a forged header cannot bloat the key set with novels. */
const MAX_KEY_LENGTH = 64;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPruneAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt and answers whether it is within the window's budget. */
  allow(key: string, now: number): boolean {
    return this.record(key, now) <= this.limit;
  }

  /** True when the key has already spent its budget. Records nothing. */
  exhausted(key: string, now: number): boolean {
    const bounded = this.bound(key);
    const cutoff = now - this.windowMs;
    const recent = this.hits.get(bounded);
    if (recent === undefined) return false;
    let live = 0;
    for (const ts of recent) if (ts > cutoff) live += 1;
    return live >= this.limit;
  }

  /** Records one unit of work performed against the key's budget. */
  charge(key: string, now: number): void {
    this.record(key, now);
  }

  /** Keys with a live attempt on record — a memory diagnostic. */
  size(): number {
    return this.hits.size;
  }

  /** Appends `now` to the key's window, dropping what has aged out; returns the live count. */
  private record(key: string, now: number): number {
    const bounded = this.bound(key);
    if (now - this.lastPruneAt >= PRUNE_EVERY_MS) this.prune(now);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(bounded) ?? []).filter((ts) => ts > cutoff);
    recent.push(now);
    this.hits.set(bounded, recent);
    return recent.length;
  }

  private bound(key: string): string {
    return key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
  }

  private prune(now: number): void {
    this.lastPruneAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((ts) => ts <= cutoff)) this.hits.delete(key);
    }
  }
}
