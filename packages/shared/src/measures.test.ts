import { describe, expect, it } from 'vitest';
import { HitTypeSchema } from './index.ts';
import {
  ACTION_HIT_TYPES,
  type BucketValues,
  HEARTBEAT_HIT_TYPE,
  isHeartbeat,
  isTrackerMilestone,
  type Measure,
  measurePerBucket,
  measureTotal,
  POPULATIONS,
  READ_MILESTONE,
} from './measures.ts';

const COUNT: Measure = { unit: 'count', population: 'pageviews', aggregate: 'sum' };
const DISTINCT: Measure = { unit: 'count', population: 'actions', aggregate: 'distinct' };
const RATE: Measure = {
  unit: 'rate',
  population: 'sessions',
  aggregate: 'ratio',
  of: { denominator: 'visits' },
};
const ENGAGEMENT: Measure = {
  unit: 'ms',
  population: 'measured_sessions',
  aggregate: 'ratio',
  of: { numerator: 'engaged_ms', denominator: 'engaged_sessions' },
};
const LONGEST: Measure = { unit: 'ms', population: 'measured_pageviews', aggregate: 'max' };

describe('the tracker milestone definition', () => {
  it('is the reserved pair exactly, and nothing near it', () => {
    expect(isTrackerMilestone(READ_MILESTONE)).toBe(true);
    expect(isTrackerMilestone({ ...READ_MILESTONE })).toBe(true);
    expect(isTrackerMilestone({ category: 'scroll', action: 'reread' })).toBe(false);
    expect(isTrackerMilestone({ category: 'Scroll', action: 'read' })).toBe(false);
    expect(isTrackerMilestone(undefined)).toBe(false);
  });
});

describe('the heartbeat definition', () => {
  it('is the one hit type that is not an action', () => {
    // The list is spelled out in measures.ts to keep the module free of a
    // runtime import from index.ts; this is what stops the two drifting.
    expect([...ACTION_HIT_TYPES, HEARTBEAT_HIT_TYPE].sort()).toEqual(
      [...HitTypeSchema.options].sort(),
    );
    expect(ACTION_HIT_TYPES.some(isHeartbeat)).toBe(false);
    expect(isHeartbeat(HEARTBEAT_HIT_TYPE)).toBe(true);
  });

  it('is what every hits population is built from', () => {
    expect(POPULATIONS.actions.hitTypes).toEqual([...ACTION_HIT_TYPES]);
    // Presence is every stored hit — the heartbeat included, deliberately: the
    // realtime hub counts it, and no metric does.
    expect(POPULATIONS.presence.hitTypes).toBeNull();
  });

  it('gives every visits population no hit types of its own', () => {
    for (const [name, spec] of Object.entries(POPULATIONS)) {
      if (spec.rows === 'visits') expect(spec.hitTypes, name).toBeNull();
      expect(spec.describes.length, name).toBeGreaterThan(0);
    }
  });
});

const days = (...values: readonly Record<string, number>[]): BucketValues[] => [...values];

describe('measureTotal', () => {
  it('adds an additive measure', () => {
    expect(measureTotal('pageviews', COUNT, days({ pageviews: 3 }, { pageviews: 4 }))).toBe(7);
    expect(measureTotal('pageviews', COUNT, [])).toBe(0);
  });

  /**
   * The refusal, which is the point of declaring the aggregate at all.
   *
   * A distinct count has no total across buckets — one person active on two days
   * is one visitor and two visitor-days — so there is nothing to return, and the
   * `undefined` makes every caller say out loud what it does instead. Under TS
   * strict a caller cannot ignore it; the all-sites cards used to add these up
   * and print a number the same site's KPI tile contradicted (defect 13).
   */
  it('refuses to total a distinct count across buckets', () => {
    expect(
      measureTotal('visitors', DISTINCT, days({ visitors: 3 }, { visitors: 4 })),
    ).toBeUndefined();
  });

  it('re-divides a ratio rather than averaging averages', () => {
    // 1 bounce of 1 visit, then 0 of 9: the rate is 0.1, not the 0.5 a mean of
    // the two daily rates would claim.
    const buckets = days({ bounce_rate: 1, visits: 1 }, { bounce_rate: 0, visits: 9 });
    expect(measureTotal('bounce_rate', RATE, buckets)).toBeCloseTo(0.1, 10);
    // No denominator anywhere is an unknown rate, never 0.
    expect(measureTotal('bounce_rate', RATE, days({ bounce_rate: 1, visits: 0 }))).toBeUndefined();
  });

  it('prefers the declared numerator when the result carries it', () => {
    const buckets = days(
      { engaged_ms: 4000, engaged_sessions: 1 },
      { engaged_ms: 6000, engaged_sessions: 3 },
    );
    expect(measureTotal('avg_engagement', ENGAGEMENT, buckets)).toBe(2500);
    // Without the numerator column it reconstructs it from value × denominator,
    // which is the same number.
    const reconstructed = days(
      { avg_engagement: 4000, engaged_sessions: 1 },
      { avg_engagement: 2000, engaged_sessions: 3 },
    );
    expect(measureTotal('avg_engagement', ENGAGEMENT, reconstructed)).toBe(2500);
  });

  it('takes the extremum of a max', () => {
    expect(
      measureTotal('max_page_ms', LONGEST, days({ max_page_ms: 9 }, { max_page_ms: 40 })),
    ).toBe(40);
  });
});

describe('measurePerBucket', () => {
  it('averages counts over the run, so a distinct one reduces legally', () => {
    const buckets = days({ visitors: 3 }, { visitors: 5 });
    expect(measurePerBucket('visitors', DISTINCT, buckets)).toBe(4);
    expect(measurePerBucket('pageviews', COUNT, days({ pageviews: 3 }, { pageviews: 5 }))).toBe(4);
  });

  it('leaves a rate as its rate — a per-bucket rate is already per bucket', () => {
    const buckets = days({ bounce_rate: 1, visits: 1 }, { bounce_rate: 0, visits: 9 });
    expect(measurePerBucket('bounce_rate', RATE, buckets)).toBeCloseTo(0.1, 10);
  });

  it('has nothing to say about an empty run', () => {
    expect(measurePerBucket('pageviews', COUNT, [])).toBeUndefined();
  });
});

describe("the 'computed' aggregate", () => {
  const COMPUTED: Measure = { unit: 'value', population: 'actions', aggregate: 'computed' };

  it('has no total and no per-bucket reduction — the server evaluated it per row', () => {
    const buckets = days({ score: 3 }, { score: 5 });
    expect(measureTotal('score', COMPUTED, buckets)).toBeUndefined();
    expect(measurePerBucket('score', COMPUTED, buckets)).toBeUndefined();
  });
});
