import {
  contentTemplate,
  type Dashboard,
  DashboardSchema,
  type Measures,
  type QueryResponse,
  type RealtimeEngagement,
  type RealtimeHit,
  type SiteInfo,
  upgradeDashboard,
} from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DashboardGrid from '../views/DashboardGrid.svelte';
import type { ViewEnv } from './types.ts';

/**
 * What the widgets actually DRAW.
 *
 * Until this file, no `.svelte` file had ever been rendered by a test here, and
 * that is where the defects were: a KPI tile writing a rate on the wrong scale,
 * a share page rendering "no visitors" when the truth was "no stream", an
 * active-now hero showing a confident 0. Every one of those is type-correct,
 * passes its unit tests, and is wrong on screen — the derivations were right and
 * nothing checked what was printed with them.
 *
 * Mounted through `DashboardGrid`, which is the real view path: layout →
 * `WidgetGrid` → registry → widget, with the environment assembled the way a
 * page assembles it. A widget tested in isolation would not have caught any of
 * the three, because all three are failures of the seam.
 */

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

const site = (id: number, name: string): SiteInfo => ({
  id,
  name,
  domains: [name],
  timezone: 'UTC',
});

const SITES = new Map([
  [1, site(1, 'pcons.org')],
  [2, site(2, 'oberbrunner.com')],
]);

const hit = (over: Partial<RealtimeHit> = {}): RealtimeHit => ({
  siteId: 1,
  ts: NOW - 45_000,
  type: 'pageview',
  visitor: { name: 'Amiable Aardvark', color: 0, ref: 'ref-a' },
  path: '/docs',
  country: 'NZ',
  city: 'Masterton',
  ...over,
});

const engaged = (over: Partial<RealtimeEngagement> = {}): RealtimeEngagement => ({
  ref: 'ref-a',
  name: 'Amiable Aardvark',
  color: 0,
  siteId: 1,
  engagedMs: 106_000,
  lastTs: NOW - 45_000,
  ...over,
});

/** A page inside the app: one session, one stream, one clock. */
const APP_PAGE: ViewEnv = {
  rangeLabel: 'last 30 days',
  scope: 1,
  now: NOW,
  realtime: {
    active: { 1: 7, 2: 2 },
    recent: [hit(), hit({ ts: NOW - 90_000, type: 'event', eventCategory: 'cta' })],
    visitorTimes: [engaged()],
  },
  sites: SITES,
  onopenrealtime: () => undefined,
  onselectsite: () => undefined,
  onfilter: () => undefined,
  ondrill: null,
  onpivot: null,
};

/**
 * A public share link: no session, so no stream, no directory, nowhere to
 * navigate and no filter row. Every withheld capability is written `null` out
 * loud (P3) — this is the environment that used to render three lies.
 */
const SHARED_PAGE: ViewEnv = {
  rangeLabel: 'last 30 days',
  scope: 1,
  now: NOW,
  realtime: null,
  sites: null,
  onopenrealtime: null,
  onselectsite: null,
  onfilter: null,
  ondrill: null,
  onpivot: null,
};

// `satisfies` rather than an annotation: `Measures` is keyed by string, so an
// annotated lookup is `Measure | undefined` and a test naming one measure would
// have to assert it exists. This keeps the check and the literal's own keys.
const MEASURES = {
  visitors: { unit: 'count', population: 'actions', aggregate: 'distinct' },
  avg_engagement: {
    unit: 'ms',
    population: 'measured_sessions',
    aggregate: 'ratio',
    of: { numerator: 'engaged_ms', denominator: 'engaged_sessions' },
  },
  bounce_rate: {
    unit: 'rate',
    population: 'sessions',
    aggregate: 'ratio',
    of: { denominator: 'visits' },
  },
} satisfies Measures;

function dashboard(grid: unknown[]): Dashboard {
  return upgradeDashboard(DashboardSchema.parse({ name: 'Test', site: 1, grid }));
}

function response(results: QueryResponse['results']): QueryResponse {
  return {
    results,
    meta: {
      generatedInMs: 1,
      dataVersion: 1,
      windows: [{ siteId: 1, timezone: 'UTC', from: '2026-07-01', to: '2026-07-30' }],
    },
  };
}

const mounted: Array<Record<string, unknown>> = [];

/** Mounts a dashboard the way a view does and hands back what it drew. */
function render(
  grid: unknown[],
  options: { results?: QueryResponse['results']; env?: ViewEnv } = {},
): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(DashboardGrid, {
      target,
      props: {
        dashboard: dashboard(grid),
        response: options.results === undefined ? undefined : response(options.results),
        error: undefined,
        refetching: false,
        env: options.env ?? APP_PAGE,
        chrome: false,
      },
    }),
  );
  return target;
}

/** Collapses the runs of whitespace Svelte's markup leaves between spans. */
function text(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
});

describe('a KPI tile writes its number the way its measure says', () => {
  const grid = [
    {
      id: 'kpis',
      viz: 'kpi-row',
      w: 12,
      h: 1,
      query: { id: 'kpis', metrics: ['visitors', 'avg_engagement', 'bounce_rate'] },
      options: { tiles: ['visitors', 'avg_engagement', 'bounce_rate'] },
    },
  ];
  const results = {
    kpis: {
      rows: [{ visitors: 1_200, avg_engagement: 106_000, bounce_rate: 0.31 }],
      measures: MEASURES,
    },
  };

  interface Tile {
    value: string;
    /** The '~' a distinct count wears, with its explanation in the title. */
    approximate: boolean;
  }

  const tiles = (root: HTMLElement): Record<string, Tile> =>
    Object.fromEntries(
      [...root.querySelectorAll('.tile')].map((tile) => {
        const label = tile.querySelector('.label');
        const mark = label?.querySelector('.approx');
        return [
          text(label).replace(/~.*$/, '').trim(),
          { value: text(tile.querySelector('.value')), approximate: mark !== null },
        ];
      }),
    );

  it('prints a rate as a percent, a duration as a duration, a count as a count', () => {
    // The unit is the server's and the writing follows it. The bounce tile once
    // wrote 0.31 as '31%' while its own sparkline held 31 and would have drawn
    // '3100%' — one number, two scales, because each side scaled for itself.
    const printed = tiles(render(grid, { results }));
    expect(printed['Bounce rate']?.value).toBe('31%');
    expect(printed['Avg engagement']?.value).toBe('1m 46s');
    expect(printed.Visitors?.value).toBe('1,200');
  });

  it('marks the distinct count approximate, and only the distinct count', () => {
    // The '~' rides on `aggregate: 'distinct'`, never on the metric's name —
    // which is what makes docs/03's claim about the UTC salt true on screen.
    const printed = tiles(render(grid, { results }));
    expect(printed.Visitors?.approximate).toBe(true);
    expect(printed['Bounce rate']?.approximate).toBe(false);
    expect(printed['Avg engagement']?.approximate).toBe(false);
  });

  it('shows an em-dash, never a zero, for a metric the answer did not carry', () => {
    const printed = tiles(
      render(grid, {
        results: { kpis: { rows: [{ visitors: 5 }], measures: { visitors: MEASURES.visitors } } },
      }),
    );
    expect(printed['Avg engagement']?.value).toBe('—');
  });
});

describe('a KPI row draws every tile its spec declares', () => {
  it('renders the content template’s four tiles — views/visit included', () => {
    // What actually shipped: `views_per_visit` was absent from the tile catalog,
    // so `tileNames` silently dropped it and the row rendered 3 of 4. Defined
    // tiles and rendered tiles must be the same list.
    const kpis = contentTemplate.build(1).grid.find((spec) => spec.id === 'kpis');
    if (kpis === undefined) throw new Error('content kpis widget expected');
    const root = render([kpis], {
      results: {
        kpis: {
          rows: [
            { pageviews: 3_000, visitors: 1_200, avg_engagement: 106_000, views_per_visit: 3.14 },
          ],
          measures: {
            ...MEASURES,
            pageviews: { unit: 'count', population: 'pageviews', aggregate: 'sum' },
            views_per_visit: {
              unit: 'value',
              population: 'sessions',
              aggregate: 'ratio',
              of: { denominator: 'visits' },
            },
          },
        },
      },
    });
    const labels = [...root.querySelectorAll('.tile .label')].map((label) =>
      text(label).replace(/~.*$/, '').trim(),
    );
    expect(labels).toHaveLength((kpis.options.tiles as string[]).length);
    expect(labels).toEqual(['Pageviews', 'Visitors', 'Avg engagement', 'Views / visit']);
    expect([...root.querySelectorAll('.tile .value')].map((value) => text(value))).toContain('3.1');
  });
});

describe('a bar list draws one row per ranked group', () => {
  const grid = [
    {
      id: 'countries',
      viz: 'bar-list',
      w: 4,
      h: 2,
      title: 'Countries',
      query: { id: 'countries', metrics: ['visitors'], dim: 'country', limit: 7 },
      options: { flags: true, nullLabel: 'Unknown' },
    },
  ];

  it('renders a flag, the region name and the count, widest bar first', () => {
    const root = render(grid, {
      results: {
        countries: {
          rows: [
            { country: 'NZ', visitors: 40 },
            { country: 'US', visitors: 120 },
            { country: null, visitors: 10 },
          ],
          measures: { visitors: MEASURES.visitors },
        },
      },
    });
    const rows = [...root.querySelectorAll('.bar-row')];
    expect(rows.map((row) => text(row))).toEqual([
      '🇺🇸 United States 120',
      '🇳🇿 New Zealand 40',
      'Unknown 10',
    ]);
    // Bar width is the share of the leader, so the ranking is visible and not
    // only ordered — a list where every bar is full says nothing.
    expect(rows.map((row) => row.querySelector('.bar')?.getAttribute('style'))).toEqual([
      'width: 100.0%;',
      'width: 33.3%;',
      'width: 8.3%;',
    ]);
  });

  it('says the range is empty rather than drawing an empty ranking', () => {
    const root = render(grid, { results: { countries: { rows: [] } } });
    expect(root.querySelectorAll('.bar-row')).toHaveLength(0);
    expect(text(root.querySelector('.widget-note'))).toBe('No data in this range.');
  });

  it('renders visitor-controlled labels as text — never as markup', () => {
    // Every string here is straight from tracked traffic (registry.ts § SECURITY
    // BOUNDARY). Svelte's escaping is the XSS defense, so it gets an assertion.
    const root = render(
      [
        {
          id: 'pages',
          viz: 'bar-list',
          w: 6,
          h: 2,
          query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 8 },
        },
      ],
      { results: { pages: { rows: [{ path: '/<img src=x onerror=alert(1)>', pageviews: 3 }] } } },
    );
    expect(root.querySelector('img')).toBeNull();
    expect(text(root.querySelector('.bar-row .name'))).toBe('/<img src=x onerror=alert(1)>');
  });

  it('carries the full label in a native title, so an ellipsized URL can be read', () => {
    const root = render(
      [
        {
          id: 'pages',
          viz: 'bar-list',
          w: 6,
          h: 2,
          query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 8 },
        },
      ],
      {
        results: {
          pages: { rows: [{ path: '/blog/a-very-long-post-slug-that-truncates/', pageviews: 3 }] },
        },
      },
    );
    expect(root.querySelector('.bar-row .name')?.getAttribute('title')).toBe(
      '/blog/a-very-long-post-slug-that-truncates/',
    );
  });
});

describe('the pivot picker becomes the whole heading once a pivot is active', () => {
  const PIVOT_PAGE: ViewEnv = { ...APP_PAGE, onpivot: () => undefined };
  const spec = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'pages',
    viz: 'bar-list',
    w: 6,
    h: 2,
    query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 8 },
    ...over,
  });

  /** The heading's own words, with the picker (and its option list) taken out. */
  const heading = (root: HTMLElement): string => {
    const head = root.querySelector('h2.pivot-head');
    const picker = head?.querySelector('select[aria-label="Breakdown"]');
    expect(picker).not.toBeNull();
    picker?.remove();
    return text(head);
  };

  it('reads "title · picker" while the saved breakdown is up', () => {
    const root = render([spec({ title: 'Top pages' })], {
      results: { pages: { rows: [] } },
      env: PIVOT_PAGE,
    });
    expect(heading(root)).toBe('Top pages ·');
  });

  it('shows the picker alone for a pivoted spec — no stale title beside it', () => {
    // What `applyPivots` hands the widget: the new dim, the title stripped —
    // "Top pages" must not sit over browser rows.
    const root = render(
      [spec({ query: { id: 'pages', metrics: ['pageviews'], dim: 'browser', limit: 8 } })],
      { results: { pages: { rows: [] } }, env: PIVOT_PAGE },
    );
    expect(heading(root)).toBe('');
  });
});

describe('time on page renders through the shared bar rows', () => {
  it('writes a duration and what the average rests on, in one .bar-row', () => {
    // The fork this replaced: `Dwell.svelte` grew its own `.bar-row` markup, so
    // its rows silently missed keyboard focus and the designed tooltip layer
    // that every other ranking got. `src/ownership.test.ts` holds the seam;
    // this holds the output.
    const root = render(
      [
        {
          id: 'dwell',
          viz: 'dwell',
          w: 6,
          h: 2,
          title: 'Time on page',
          query: { id: 'dwell', kind: 'dwell', limit: 10 },
        },
      ],
      {
        results: {
          dwell: {
            rows: [
              { path: '/blog', views_measured: 1_400, avg_page_ms: 92_400, max_page_ms: 740_000 },
              { path: '/', views_measured: 3_000, avg_page_ms: 23_100, max_page_ms: 180_000 },
            ],
          },
        },
      },
    );
    const rows = [...root.querySelectorAll('.bar-row')];
    expect(rows.map((row) => text(row))).toEqual([
      '/blog 1m 32s max 12m 20s · 1,400 measured',
      '/ 23s max 3m 00s · 3,000 measured',
    ]);
    // The shared row's affordances came free with the shared row.
    expect(rows.every((row) => row.getAttribute('tabindex') === '0')).toBe(true);
    expect(rows.some((row) => row.classList.contains('clickable'))).toBe(false);
  });
});

describe('the realtime widgets read the stream the page holds', () => {
  const grid = [
    { id: 'now', viz: 'active-now', w: 3, h: 1, options: {} },
    { id: 'who', viz: 'visitor-tally', w: 3, h: 2, options: {} },
    { id: 'feed', viz: 'feed', w: 6, h: 2, options: {} },
    { id: 'geo', viz: 'realtime-countries', w: 4, h: 2, options: {} },
  ];

  it('shows the count, the visitor, their engaged time and where they are', () => {
    // Three defects in one assertion: `active-now` read 0 on a site dashboard,
    // the tally never showed a duration there, and both were the same fault —
    // a view that passed the feed and left the rest of the stream behind.
    const root = render(grid, { results: {} });
    expect(text(root.querySelector('.active-now'))).toBe('7 active now');
    expect(text(root.querySelector('.visitor-row'))).toBe(
      '▸ Amiable Aardvark · 2 hits · 1m 46s · Masterton, NZ',
    );
    expect(text(root.querySelector('.feed-row'))).toContain('Masterton, NZ');
    expect(text(root.querySelector('.bar-row'))).toBe('🇳🇿 New Zealand 2');
  });

  it('draws two rows for two visitors who drew the same alias', () => {
    // Invariant 8, in the layer the derivation tests do not reach. 384 names
    // serve any number of visitors, so a collision is ordinary — and the tally
    // used to key its `{#each}`, its expand state and its hover on the NAME, so
    // a collided pair shared one key and merged into each other's row.
    const twins = [
      hit({ visitor: { name: 'Amiable Aardvark', color: 0, ref: 'ref-a' } }),
      hit({ visitor: { name: 'Amiable Aardvark', color: 0, ref: 'ref-b' } }),
    ];
    const root = render(grid, {
      results: {},
      env: { ...APP_PAGE, realtime: { active: { 1: 2 }, recent: twins, visitorTimes: [] } },
    });
    expect(root.querySelectorAll('.visitor-row')).toHaveLength(2);
  });

  it('scopes to the site on screen and counts every site at "all"', () => {
    const root = render(grid, {
      results: {},
      env: { ...APP_PAGE, scope: 'all' },
    });
    expect(text(root.querySelector('.active-now'))).toBe('9 active now');
    // At 'all' a feed row badges which site it came from.
    expect(text(root.querySelector('.feed-row'))).toContain('pcons.org');
  });
});

describe('a page that cannot feed a widget says so once, centrally', () => {
  const grid = [
    { id: 'now', viz: 'active-now', w: 3, h: 1, options: {} },
    { id: 'geo', viz: 'realtime-countries', w: 4, h: 2, options: {} },
    {
      id: 'pages',
      viz: 'bar-list',
      w: 6,
      h: 2,
      title: 'Top pages',
      query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 8 },
    },
  ];

  it('blames the missing stream, never the visitors', () => {
    const root = render(grid, {
      env: SHARED_PAGE,
      results: { pages: { rows: [{ path: '/docs', pageviews: 12 }] } },
    });
    const notes = [...root.querySelectorAll('.widget-note')].map((note) => text(note));
    expect(notes).toEqual([
      'No live stream on this page — realtime runs in the app, not behind a share link.',
      'No live stream on this page — realtime runs in the app, not behind a share link.',
    ]);
  });

  it('draws no confident zero and no "no visitors" where it has no stream', () => {
    // What a share page used to render: a hero reading 0 (as if nobody was
    // there) and "No located visitors in the last 30 minutes" (as if it had
    // looked). Both are claims about visitors; the truth is about the page.
    const root = render(grid, { env: SHARED_PAGE, results: { pages: { rows: [] } } });
    expect(root.querySelector('.active-now')).toBeNull();
    expect(root.textContent).not.toMatch(/visitors in the last 30 minutes/i);
  });

  it('still renders the widgets it CAN feed, beside the ones it cannot', () => {
    const root = render(grid, {
      env: SHARED_PAGE,
      results: { pages: { rows: [{ path: '/docs', pageviews: 12 }] } },
    });
    expect(text(root.querySelector('.bar-row'))).toBe('/docs 12');
    // And with no filter row to add a chip to, a row is not a button.
    expect(root.querySelector('.bar-row')?.getAttribute('role')).toBeNull();
  });

  it('names a viz nothing implements yet instead of breaking the dashboard', () => {
    const root = render([{ id: 'x', viz: 'map', w: 6, h: 2, options: {} }], { results: {} });
    expect(text(root.querySelector('.widget-note'))).toBe('The “map” widget isn’t available yet.');
  });
});

describe('every chart value is reachable without a pointer (docs/05 § Accessibility)', () => {
  /** The visually-hidden table a chart carries: header row, then each row's cells. */
  const table = (root: HTMLElement): string[][] =>
    [...root.querySelectorAll('.sr-only table tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => text(cell)),
    );

  const series = [
    {
      id: 'series',
      viz: 'timeseries',
      w: 12,
      h: 2,
      title: 'Traffic',
      query: { id: 'series', metrics: ['visitors', 'pageviews'], bucket: 'day' },
    },
  ];
  const seriesResult = {
    series: {
      bucket: 'day' as const,
      rows: [
        { bucket: '2026-07-28', visitors: 40, pageviews: 95 },
        { bucket: '2026-07-29', visitors: 1_250, pageviews: 3_010 },
      ],
    },
  };

  it('tables a line chart bucket by bucket', () => {
    const root = render(series, { results: seriesResult });
    expect(text(root.querySelector('.sr-only caption'))).toBe('Traffic — exact values per bucket');
    expect(table(root)).toEqual([
      ['Bucket', 'Visitors', 'Pageviews'],
      ['Tue, Jul 28', '40', '95'],
      ['Wed, Jul 29', '1,250', '3,010'],
    ]);
  });

  it('steps a line chart with the keyboard, saying each bucket', () => {
    // happy-dom lays nothing out; give the plot the width a card would.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 600,
    });
    try {
      const root = render(series, { results: seriesResult });
      flushSync();
      const plot = root.querySelector<SVGElement>('svg[role="slider"]');
      expect(plot?.getAttribute('tabindex')).toBe('0');
      plot?.dispatchEvent(new FocusEvent('focus'));
      flushSync();
      expect(plot?.getAttribute('aria-valuetext')).toBe(
        'Wed, Jul 29: 1,250 visitors, 3,010 pageviews',
      );
      plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      flushSync();
      expect(plot?.getAttribute('aria-valuetext')).toBe('Tue, Jul 28: 40 visitors, 95 pageviews');
      expect(text(root.querySelector('.chart-tip .tip-title'))).toBe('Tue, Jul 28');
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
    }
  });

  it('tables a histogram band by band', () => {
    const root = render(
      [
        {
          id: 'scroll',
          viz: 'histogram',
          w: 6,
          h: 2,
          title: 'Scroll depth',
          query: { id: 'scroll', kind: 'distribution', of: 'scroll' },
        },
      ],
      {
        results: {
          scroll: {
            rows: [
              { bucket: 0, legs: 12 },
              { bucket: 9, legs: 3_400 },
            ],
          },
        },
      },
    );
    const rows = table(root);
    expect(rows[0]).toEqual(['Band', 'Views']);
    expect(rows[1]).toEqual(['0–10%', '12']);
    expect(rows.at(-1)).toEqual(['90–100%', '3,400']);
  });
});
