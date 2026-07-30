import { describe, expect, it } from 'vitest';
import { RateLimiter } from './ratelimit.ts';

const T0 = 1_700_000_000_000;

describe('RateLimiter', () => {
  it('allows the limit and blocks the attempt after it', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i += 1) expect(limiter.allow('a', T0 + i)).toBe(true);
    expect(limiter.allow('a', T0 + 5)).toBe(false);
  });

  it('keys are independent — one hammered IP never blocks another', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.allow('a', T0)).toBe(true);
    expect(limiter.allow('a', T0)).toBe(false);
    expect(limiter.allow('b', T0)).toBe(true);
  });

  it('slides: attempts age out of the window one by one', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.allow('a', T0)).toBe(true);
    expect(limiter.allow('a', T0 + 30_000)).toBe(true);
    expect(limiter.allow('a', T0 + 40_000)).toBe(false);
    // T0 has aged out; the T0+30k attempt (and the blocked one) still count.
    expect(limiter.allow('a', T0 + 61_000)).toBe(false);
    expect(limiter.allow('a', T0 + 101_000)).toBe(true);
  });

  it('charges the work, not the attempt: a refusal leaves the window untouched', () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.charge('a', T0);
    limiter.charge('a', T0);
    expect(limiter.exhausted('a', T0)).toBe(true);

    // Knocking, repeatedly, right up to the edge of the window records nothing —
    // so the two charges age out on schedule and the caller gets back in.
    for (let t = T0 + 3_000; t < T0 + 60_000; t += 3_000) {
      expect(limiter.exhausted('a', t)).toBe(true);
    }
    expect(limiter.exhausted('a', T0 + 60_000)).toBe(false);
  });

  it('prunes idle keys instead of remembering every IP forever', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 50; i += 1) limiter.allow(`ip-${i}`, T0);
    expect(limiter.size()).toBe(50);
    limiter.allow('late', T0 + 120_000);
    expect(limiter.size()).toBe(1);
  });
});
