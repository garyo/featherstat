import {
  allSitesTemplate,
  collectBatch,
  type Dashboard,
  hourlyWhenIntraday,
  overviewTemplate,
  type QueryRequest,
  type RangePreset,
} from '@featherstat/shared';

// The dashboards the web app actually ships, from the shared template registry.
const siteOverview = overviewTemplate.build(1);
const allSites = (siteIds: readonly number[]): Dashboard => allSitesTemplate.build('all', siteIds);

import type { Db } from '../../src/db/index.ts';
import { executeQueryRequest } from '../../src/query/executor.ts';
import type { ReadMeasurement } from './bench.guard.ts';
import type { Corpus } from './generate.ts';

/**
 * The read half of the perf gate (docs/02 § Performance budget).
 *
 * `bench.ts` gated ingest and nothing gated reads, which is backwards for a
 * project whose reason to exist is that Matomo's dashboards were slow: nobody
 * feels a flush, everybody feels a dashboard. These shapes run against the same
 * corpus the ingest bench just wrote, in the same process, so the whole read
 * budget costs no extra ingest — only the queries themselves.
 *
 * Shapes are the batches the app actually sends, assembled by `collectBatch` from
 * the shipped dashboards, plus the two query kinds a dashboard cannot reach
 * (an unbounded 2-D breakdown, and journeys). A hand-written query list would
 * drift from what the app asks; these cannot.
 */

/** Midday of the corpus's last day: every preset lands inside real traffic, and no `Date.now()` enters. */
const CLOCK_OFFSET_MS = 43_200_000;

/** Discarded, so every timed run reads a warm SQLite page cache rather than one arbitrary cold one. */
const WARMUPS = 1;
const REPETITIONS = 3;

interface ReadShape {
  name: string;
  request(corpus: Corpus): QueryRequest;
}

/** The batch a view sends for a dashboard — the same assembly the share route does server-side. */
function batchOf(
  dashboard: Dashboard,
  site: QueryRequest['site'],
  range: RangePreset,
  compare?: 'previous',
): QueryRequest {
  return {
    site,
    range: { preset: range },
    compare,
    queries: hourlyWhenIntraday(collectBatch(dashboard).queries, range),
  };
}

/** Not UTC, so a timezone cost shows up in the measurement rather than hiding in it. */
const SITE = 4;

/** The corpus's heaviest site — the one `journeys.test.ts` timed its sequences against. */
const BUSIEST_SITE = 2;

const allSitesDashboard = (corpus: Corpus): Dashboard =>
  allSites(corpus.sites.map((site) => site.id));

/** Each shape's comment says what a reader is waiting for when it runs. */
const READ_SHAPES: readonly ReadShape[] = [
  {
    // the page most people leave open — hourly buckets, one site
    name: 'site dashboard @ today',
    request: () => batchOf(siteOverview, SITE, 'today', 'previous'),
  },
  {
    // the rolling window: the same hourly shape as `today`, but its bounds fall
    // inside two local dates, so it is the one shape that pays for the ts
    // refinement in the bounds CTE (query/compiler.ts)
    name: 'site dashboard @ 24h',
    request: () => batchOf(siteOverview, SITE, '24h', 'previous'),
  },
  {
    // the default view of one site
    name: 'site dashboard @ 7d',
    request: () => batchOf(siteOverview, SITE, '7d', 'previous'),
  },
  {
    // the longest range the range picker offers, one site
    name: 'site dashboard @ 90d',
    request: () => batchOf(siteOverview, SITE, '90d', 'previous'),
  },
  {
    // a 2-D breakdown with both dimensions bounded (the traffic heatmap)
    name: 'hours x weekday @ 90d',
    request: () => ({
      site: SITE,
      range: { preset: '90d' },
      queries: [{ id: 'heatmap', metrics: ['pageviews'], dim: 'local_hour', dim2: 'weekday' }],
    }),
  },
  {
    // the deliberately unlimited breakdown behind the all-sites cards (R20)
    name: 'paths x day @ 90d, all sites',
    request: () => ({
      site: 'all',
      range: { preset: '90d' },
      queries: [{ id: 'pages', metrics: ['pageviews'], dim: 'path', bucket: 'day' }],
    }),
  },
  {
    // the widest thing the app can ask for: every site, every day, twice over
    name: 'all-sites dashboard @ 90d + compare',
    request: (corpus) => batchOf(allSitesDashboard(corpus), 'all', '90d', 'previous'),
  },
  {
    // the changes kind: eight grouped sub-queries (four dims × two windows),
    // unlimited group-bys that mostly ride the rollups, joined in JS
    name: 'what changed @ 30d vs previous',
    request: () => ({
      site: SITE,
      range: { preset: '30d' },
      compare: 'previous',
      queries: [
        {
          id: 'changes',
          kind: 'changes',
          metric: 'visits',
          dims: ['path', 'ref_domain', 'utm_campaign', 'country'],
          limit: 8,
        },
      ],
    }),
  },
  {
    // the sequence kinds, which no other shape exercises, at the JourneysView's
    // own depth and limit
    name: 'journeys @ 90d, all sites',
    request: () => ({
      site: 'all',
      range: { preset: '90d' },
      queries: [
        { id: 'sankey', kind: 'transitions', steps: 3, limit: 20 },
        { id: 'flows', kind: 'flows', steps: 4, limit: 20 },
      ],
    }),
  },
  {
    // the deepest, widest journey one site can be asked for — `journeys.test.ts`
    // used to assert this under 100 ms with a wall clock, inside the parallel
    // test suite, where the number moved with whatever else was running
    name: 'journeys @ 90d, busiest site',
    request: () => ({
      site: BUSIEST_SITE,
      range: { preset: '90d' },
      queries: [
        { id: 'sankey', kind: 'transitions', steps: 4, limit: 50 },
        { id: 'flows', kind: 'flows', steps: 4, limit: 50 },
      ],
    }),
  },
];

export function measureReads(db: Db, corpus: Corpus): ReadMeasurement[] {
  const now = corpus.endMs - CLOCK_OFFSET_MS;
  return READ_SHAPES.map((shape) => {
    const request = shape.request(corpus);
    for (let i = 0; i < WARMUPS; i += 1) executeQueryRequest(db, request, { now });

    const timings: number[] = [];
    let rows = 0;
    let bytes = 0;
    for (let i = 0; i < REPETITIONS; i += 1) {
      const started = performance.now();
      const response = executeQueryRequest(db, request, { now });
      timings.push(performance.now() - started);
      rows = Object.values(response.results).reduce(
        (total, entry) => total + ('rows' in entry ? entry.rows.length : 0),
        0,
      );
      // `meta.generatedInMs` and each result's `ms` are wall clock, so they would
      // make the size vary run to run; the shape of the answer is what is wanted.
      bytes = Buffer.byteLength(JSON.stringify(response, omitMs));
    }
    timings.sort((a, b) => a - b);
    return {
      name: shape.name,
      medianMs: timings[Math.floor(timings.length / 2)] ?? 0,
      slowestMs: timings[timings.length - 1] ?? 0,
      rows,
      bytes,
    };
  });
}

/** Timings are wall clock; excluding them keeps the reported byte count reproducible. */
function omitMs(key: string, value: unknown): unknown {
  return key === 'ms' || key === 'generatedInMs' ? undefined : value;
}
