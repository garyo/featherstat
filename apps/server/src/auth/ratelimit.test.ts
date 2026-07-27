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

  it('prunes idle keys instead of remembering every IP forever', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 50; i += 1) limiter.allow(`ip-${i}`, T0);
    expect(limiter.size()).toBe(50);
    limiter.allow('late', T0 + 120_000);
    expect(limiter.size()).toBe(1);
  });
});
