/**
 * In-memory sliding-window rate limiter for login attempts (docs/02 § Security
 * posture). Keys are client IPs held transiently in memory — never persisted,
 * never logged (CLAUDE.md invariant 3).
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
    const bounded = key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
    if (now - this.lastPruneAt >= PRUNE_EVERY_MS) this.prune(now);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(bounded) ?? []).filter((ts) => ts > cutoff);
    recent.push(now);
    this.hits.set(bounded, recent);
    return recent.length <= this.limit;
  }

  /** Keys with a live attempt on record — a memory diagnostic. */
  size(): number {
    return this.hits.size;
  }

  private prune(now: number): void {
    this.lastPruneAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((ts) => ts <= cutoff)) this.hits.delete(key);
    }
  }
}
