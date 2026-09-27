import { describe, expect, it } from 'vitest';
import {
  AdminSiteCreateSchema,
  BaseDimensionSchema,
  CollectHitSchema,
  DAY_MS,
  DashboardSchema,
  EVENT_ONLY_DIMENSIONS,
  HitSchema,
  MAX_QUERIES_PER_BATCH,
  MAX_RANGE_DAYS,
  NtfyUrlSchema,
  QueryRequestSchema,
  SESSION_ONLY_DIMENSIONS,
  variesWithinSession,
} from './index.ts';

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

describe('props on the wire (docs/03 § Props)', () => {
  it('carries a valid bag through CollectHitSchema and HitSchema alike', () => {
    const props = { plan: 'pro', seats: 3, beta: true };
    expect(CollectHitSchema.parse({ type: 'event', category: 'a', action: 'b', props }).props) //
      .toEqual(props);
    expect(HitSchema.parse({ siteId: 1, type: 'pageview', props }).props).toEqual(props);
  });

  it('a malformed bag costs the bag, never the hit (invariant 4)', () => {
    for (const bad of [
      'not-an-object',
      { 'Bad Key!': 'x' }, // charset
      { nested: { a: 1 } }, // only scalars
      { nil: null },
      { big: 'x'.repeat(201) },
      { nan: Number.NaN },
    ]) {
      const hit = CollectHitSchema.parse({ type: 'pageview', url: 'https://a.test/', props: bad });
      expect(hit.props, JSON.stringify(bad)).toBeUndefined();
      expect(hit.type).toBe('pageview');
    }
  });

  it('HitSchema — the post-parse boundary — rejects instead of degrading', () => {
    expect(() =>
      HitSchema.parse({ siteId: 1, type: 'pageview', props: { 'Bad Key!': 'x' } }),
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
    expect(flows && 'kind' in flows && 'limit' in flows && flows.limit).toBe(20); // default applied
  });

  it('refuses a limit over a bucketed breakdown — it would keep the earliest buckets', () => {
    const query = (extra: Record<string, unknown>) =>
      QueryRequestSchema.safeParse({
        ...base,
        queries: [{ id: 'q', metrics: ['pageviews'], ...extra }],
      }).success;
    expect(query({ bucket: 'day', dim: 'path', limit: 10 })).toBe(false);
    expect(query({ bucket: 'day', dim2: 'site', limit: 10 })).toBe(false);
    // Each pair alone is a fine question.
    expect(query({ bucket: 'day', dim: 'path' })).toBe(true);
    expect(query({ dim: 'path', limit: 10 })).toBe(true);
    expect(query({ bucket: 'day', limit: 10 })).toBe(true);
  });

  it('bounds an explicit range: ordered, and at most MAX_RANGE_DAYS long', () => {
    const accepts = (range: unknown, compare?: unknown) =>
      QueryRequestSchema.safeParse({
        site: 4,
        range,
        ...(compare === undefined ? {} : { compare }),
        queries: [{ id: 'q', metrics: ['visits'] }],
      }).success;
    const lastDay = new Date(Date.parse('2016-01-01') + (MAX_RANGE_DAYS - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const pastIt = new Date(Date.parse(lastDay) + DAY_MS).toISOString().slice(0, 10);
    expect(accepts({ from: '2016-01-01', to: lastDay })).toBe(true);
    expect(accepts({ from: '2016-01-01', to: pastIt })).toBe(false);
    expect(accepts({ from: '0001-01-01', to: '9999-12-31' })).toBe(false);
    expect(accepts({ from: '2026-06-02', to: '2026-06-01' })).toBe(false);
    expect(accepts({ from: '2026-06-01', to: '2026-06-01' })).toBe(true);
    // The explicit compare window is held to the same bounds.
    expect(accepts({ preset: '30d' }, { from: '0001-01-01', to: '9999-12-31' })).toBe(false);
    expect(accepts({ preset: '30d' }, { from: '2026-05-01', to: '2026-05-30' })).toBe(true);
  });

  it('accepts a dwell query and defaults its depth', () => {
    const req = QueryRequestSchema.parse({
      ...base,
      queries: [{ id: 'dwell', kind: 'dwell' }],
    });
    const dwell = req.queries[0];
    expect(dwell && 'kind' in dwell && 'limit' in dwell && dwell.limit).toBe(10);
  });

  /**
   * A `kind` query carries its own filters like a metric query does. The guard
   * is here because the failure was SILENT: zod strips what a schema does not
   * declare, so a filtered widget parsed clean and answered the unfiltered
   * question — byte-identical rows under two different labels.
   */
  it.each(['transitions', 'flows', 'dwell', 'adjacency', 'distribution', 'changes'])(
    'keeps a %s query’s own filters instead of stripping them',
    (kind) => {
      const filters = [{ dim: 'country', op: 'eq', value: 'SG' }];
      const req = QueryRequestSchema.parse({
        ...base,
        compare: 'previous',
        queries: [
          {
            id: 'q',
            kind,
            filters,
            ...(kind === 'adjacency' ? { path: '/pricing', direction: 'in' } : {}),
            ...(kind === 'distribution' ? { of: 'scroll' } : {}),
          },
        ],
      });
      expect(req.queries[0]?.filters).toEqual(filters);
    },
  );

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

describe('AdminSiteCreateSchema domains', () => {
  const parse = (domain: string) =>
    AdminSiteCreateSchema.safeParse({ name: 'S', domains: [domain] }).success;

  it('accepts hostname shapes, with an optional port', () => {
    expect(parse('example.com')).toBe(true);
    expect(parse('www.Example-Site.co.uk')).toBe(true);
    expect(parse('localhost:5173')).toBe(true);
    expect(parse('xn--bcher-kva.example')).toBe(true);
  });

  it('rejects stored-XSS shapes: markup, schemes, spaces', () => {
    expect(parse('<script>alert(2)</script>')).toBe(false);
    expect(parse('javascript:alert(3)')).toBe(false);
    expect(parse('https://example.com')).toBe(false);
    expect(parse('two words')).toBe(false);
    expect(parse('-leading.example')).toBe(false);
  });
});

describe('NtfyUrlSchema', () => {
  const parse = (url: string) => NtfyUrlSchema.safeParse(url).success;

  it('accepts https anywhere and http only to loopback', () => {
    expect(parse('https://ntfy.example.com')).toBe(true);
    expect(parse('https://ntfy.example.com/base')).toBe(true);
    // Self-hosted ntfy on the operator's LAN is a first-class deployment.
    expect(parse('https://192.168.0.10')).toBe(true);
    expect(parse('https://10.0.0.5:9000')).toBe(true);
    expect(parse('http://localhost:8080')).toBe(true);
    expect(parse('http://127.0.0.1')).toBe(true);
    expect(parse('http://ntfy.example.com')).toBe(false);
    expect(parse('ftp://ntfy.example.com')).toBe(false);
    expect(parse('not a url')).toBe(false);
  });

  it('rejects cloud-metadata and link-local hosts (SSRF: no ntfy lives there)', () => {
    expect(parse('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(parse('http://169.254.169.254')).toBe(false);
    expect(parse('https://metadata.google.internal/computeMetadata/v1/')).toBe(false);
    expect(parse('https://Metadata.Google.Internal')).toBe(false);
    expect(parse('https://[fe80::1]')).toBe(false);
  });

  it('rejects query strings and fragments — the topic joins as a path segment', () => {
    expect(parse('https://ntfy.example.com?x=1')).toBe(false);
    expect(parse('https://ntfy.example.com/#frag')).toBe(false);
    expect(parse('https://ntfy.example.com/base/')).toBe(true);
  });
});

describe('variesWithinSession', () => {
  it('is true for exactly the dimensions the sessions table does not carry', () => {
    // The rule the filter editor offers "whole visit" by: a dimension the
    // session row holds has ONE value for the visit, so both scopes agree.
    for (const dim of EVENT_ONLY_DIMENSIONS) expect(variesWithinSession(dim)).toBe(true);
    for (const dim of SESSION_ONLY_DIMENSIONS) expect(variesWithinSession(dim)).toBe(false);
    for (const dim of [
      'country',
      'browser',
      'os',
      'device_type',
      'ref_domain',
      'utm_campaign',
    ] as const) {
      expect(variesWithinSession(dim), dim).toBe(false);
    }
  });

  it('counts a custom prop, which rides an event row', () => {
    expect(variesWithinSession('prop:plan')).toBe(true);
  });

  it('stays exhaustive over the dimension enum', () => {
    // Not an assertion about the split — an assertion that every dimension has
    // an answer, so a new one cannot slip through undecided.
    for (const dim of BaseDimensionSchema.options) {
      expect(typeof variesWithinSession(dim), dim).toBe('boolean');
    }
  });
});
