import { describe, expect, it } from 'vitest';
import { DashboardSchema, HitSchema, MAX_QUERIES_PER_BATCH, QueryRequestSchema } from './index.ts';

describe('HitSchema', () => {
  it('accepts a minimal pageview', () => {
    const hit = HitSchema.parse({
      siteId: 4,
      type: 'pageview',
      url: 'https://deep-timeline.org/timeline',
    });
    expect(hit.siteId).toBe(4);
  });

  it('accepts the packzen server-side signup event shape', () => {
    const hit = HitSchema.parse({
      siteId: 6,
      type: 'event',
      event: { category: 'signup', action: 'account-created' },
    });
    expect(hit.event?.category).toBe('signup');
  });

  it('rejects a malformed visitorId', () => {
    expect(() => HitSchema.parse({ siteId: 1, type: 'pageview', visitorId: 'not-hex!' })).toThrow();
  });

  it('rejects an event missing its action', () => {
    expect(() =>
      HitSchema.parse({ siteId: 1, type: 'event', event: { category: 'signup' } }),
    ).toThrow();
  });
});

describe('QueryRequestSchema', () => {
  const base = { site: 4, range: { preset: '30d' } };

  it('accepts a mixed metric + sequence batch', () => {
    const req = QueryRequestSchema.parse({
      ...base,
      queries: [
        { id: 'kpis', metrics: ['visitors', 'pageviews', 'bounce_rate'] },
        { id: 'series', metrics: ['visitors'], bucket: 'day' },
        { id: 'journeys', kind: 'flows', steps: 4 },
      ],
    });
    expect(Object.keys(req.queries)).toHaveLength(3);
    const flows = req.queries[2];
    expect(flows && 'kind' in flows && flows.limit).toBe(20); // default applied
  });

  it('rejects an oversized batch', () => {
    const queries = Array.from({ length: MAX_QUERIES_PER_BATCH + 1 }, (_, i) => ({
      id: `q${i}`,
      metrics: ['visitors'],
    }));
    expect(() => QueryRequestSchema.parse({ ...base, queries })).toThrow();
  });

  it('rejects an unknown dimension', () => {
    expect(() =>
      QueryRequestSchema.parse({
        ...base,
        queries: [{ id: 'x', metrics: ['visitors'], dim: 'user_secret' }],
      }),
    ).toThrow();
  });
});

describe('DashboardSchema', () => {
  it('round-trips a small dashboard and applies option defaults', () => {
    const dash = DashboardSchema.parse({
      name: 'overview',
      site: 'all',
      grid: [{ id: 'cards', viz: 'site-cards', w: 12, h: 4 }],
    });
    expect(dash.grid[0]?.options).toEqual({});
  });
});
