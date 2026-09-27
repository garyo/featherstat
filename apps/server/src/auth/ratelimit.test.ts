import { describe, expect, it } from 'vitest';
import { FailureBudget, RateLimiter } from './ratelimit.ts';

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

describe('FailureBudget', () => {
  const limits = { perAddress: 3, perAccount: 4, global: 6, windowMs: 60_000 };

  it('refuses an address only after its own failures, whatever its successes', () => {
    const budget = new FailureBudget(limits);
    for (let i = 0; i < 3; i += 1) {
      expect(budget.refuses('a', 'acct', T0)).toBe(false);
      budget.fail('a', 'acct', T0);
    }
    expect(budget.refuses('a', 'acct', T0)).toBe(true);
    expect(budget.refuses('a', 'other', T0)).toBe(true); // the address earned it
    expect(budget.refuses('b', 'acct', T0)).toBe(false);
    expect(budget.refuses('a', 'acct', T0 + 60_001)).toBe(false);
  });

  it('under an account flood refuses addresses that failed, never clean ones', () => {
    const budget = new FailureBudget(limits);
    for (const address of ['a', 'b', 'c', 'd']) budget.fail(address, 'acct', T0);
    expect(budget.refuses('a', 'acct', T0)).toBe(true);
    expect(budget.refuses('e', 'acct', T0)).toBe(false);
    expect(budget.refuses('a', 'quiet', T0)).toBe(false);
  });

  it('under a door-wide flood does the same for every account', () => {
    const budget = new FailureBudget({ ...limits, perAccount: undefined });
    for (let i = 0; i < 6; i += 1) budget.fail(`x${i}`, `acct${i}`, T0);
    expect(budget.refuses('x0', 'fresh', T0)).toBe(true);
    expect(budget.refuses('clean', 'fresh', T0)).toBe(false);
  });
});
