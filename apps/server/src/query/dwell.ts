import {
  type DistributionQuery,
  type DwellQuery,
  type FilterNode,
  type Measures,
  PING_CLAMP_MS,
  type SiteWindow,
} from '@featherstat/shared';
import type { CompileError } from './compiler.ts';
import { populationWhere } from './population.ts';
import { type SessionScope, sessionScope } from './session-scope.ts';

/**
 * DwellQuery → parameterized SQL: time on page (docs/03 § Sessionization,
 * docs/04 § 3), over the session-scoped envelope (session-scope.ts).
 *
 * Attribution rule, one sentence: every event of a picked session — pings
 * INCLUDED — credits `min(next event's ts − its own ts, PING_CLAMP_MS)` to the
 * CURRENT page, the most recent pageview at or before it in the session. That
 * is the same clamped-gap accrual the sessionizer uses for `engaged_ms`, only
 * attributed per page instead of per session, and it is why a heartbeat makes a
 * single-page visit measurable at all (the Matomo failure this project fixes).
 *
 * What it deliberately does NOT do, because the honest answer is "unknown":
 *
 * - The session's LAST event has no next event, so its gap is unmeasurable and
 *   contributes nothing. A page whose only event is that last one therefore
 *   yields no row at all — it is excluded from the average rather than dragging
 *   it down with a fabricated zero. `views_measured` says how many page views
 *   the numbers actually rest on.
 * - Events before the session's first pageview (page_idx 0 — a server-side
 *   webhook event, say) belong to no page and are dropped.
 * - Pings renumber nothing: `page_idx` counts pageviews only, so a heartbeat
 *   never splits a page into two.
 *
 * The `distribution` kind histograms the same legs — the CTEs below are shared,
 * so the two kinds cannot disagree about what a leg is.
 */

export interface CompiledLegs {
  kind: 'dwell' | 'distribution';
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
  /** What this result's columns count — the executor forwards it verbatim. */
  measures: Measures;
}

/**
 * What the dwell card's columns count (docs/04 § 3). Fixed — the shape is the
 * answer, so there is nothing to route.
 *
 * The population is the whole point of stating them: `measured_pageviews` is
 * page views something followed, which is why "time on page 31 s" and
 * "avg engagement 2 s" can both be true of the same traffic. One is per page
 * leg the clock could reach, the other per MEASURED VISIT — different
 * populations, not a contradiction.
 */
export const DWELL_MEASURES: Measures = {
  views_measured: { unit: 'count', population: 'measured_pageviews', aggregate: 'sum' },
  avg_page_ms: {
    unit: 'ms',
    population: 'measured_pageviews',
    aggregate: 'ratio',
    of: { denominator: 'views_measured' },
  },
  max_page_ms: { unit: 'ms', population: 'measured_pageviews', aggregate: 'max' },
  /**
   * How far down the page they got. Its own population, because a page view can
   * be timed and still carry no reading — so `views_scrolled` says what the
   * average rests on, exactly as `views_measured` does for the time.
   *
   * A `rate`, not a new unit: `rate` is a 0–1 fraction the client scales once
   * (`widgets/format.ts`), which is why the SQL divides by 100 rather than
   * teaching the tree a second spelling of "percentage".
   */
  views_scrolled: { unit: 'count', population: 'scrolled_pageviews', aggregate: 'sum' },
  avg_scroll_pct: {
    unit: 'rate',
    population: 'scrolled_pageviews',
    aggregate: 'ratio',
    of: { denominator: 'views_scrolled' },
  },
};

/** One `legs` column per distribution; the population says which legs it counts. */
function distributionMeasures(of: DistributionQuery['of']): Measures {
  return {
    legs: {
      unit: 'count',
      population: of === 'dwell' ? 'measured_pageviews' : 'scrolled_pageviews',
      aggregate: 'sum',
    },
  };
}

/** A session's rows in order, each knowing its page and its successor's clock. */
const ORDERED_CTE = [
  'ordered AS (',
  '  SELECT e.session_id AS sid, e.ts AS ts, e.type AS type, e.path AS path,',
  '    e.scroll_pct AS scroll_pct,',
  `    SUM(CASE WHEN ${populationWhere('pageviews', 'e')} THEN 1 ELSE 0 END) OVER w AS page_idx,`,
  '    LEAD(e.ts) OVER w AS next_ts',
  '  FROM events e JOIN scoped ON e.session_id = scoped.sid',
  '  WINDOW w AS (PARTITION BY e.session_id ORDER BY e.seq)',
  ')',
].join('\n');

/** One row per timed page leg. Binds one `?`: the clamp — bound, never inlined,
 * the same discipline as bounce_rate's threshold. */
const DWELL_CTE = [
  'dwell AS (',
  '  SELECT sid, page_idx, SUM(MIN(next_ts - ts, ?)) AS ms',
  '  FROM ordered WHERE next_ts IS NOT NULL AND page_idx > 0',
  '  GROUP BY sid, page_idx',
  ')',
].join('\n');

/**
 * One row per MEASURED page leg — deliberately NOT filtered on next_ts, unlike
 * `dwell`. A page's deepest reading arrives on its exit ping, which is the
 * session's LAST row and so has no next_ts; reading scroll under dwell's filter
 * would return the second-deepest reading of every page, every time — a bias
 * that is silent, systematic and always downward. Depth is a high-water mark,
 * not a gap: there is nothing unmeasurable about the last row's own reading.
 */
const SCROLL_CTE = [
  'scroll AS (',
  '  SELECT sid, page_idx, MAX(scroll_pct) AS pct',
  '  FROM ordered WHERE page_idx > 0 AND scroll_pct IS NOT NULL',
  '  GROUP BY sid, page_idx',
  ')',
].join('\n');

/** The pageview row a leg belongs to — grouped upstream, so it cannot fan out counts. */
function pageJoin(legs: 'dwell' | 'scroll'): string {
  return [
    `JOIN ordered page ON page.sid = ${legs}.sid AND page.page_idx = ${legs}.page_idx`,
    `  AND ${populationWhere('pageviews', 'page')}`,
  ].join('\n');
}

// NULL never labels a page: a title-only pageview (no URL) reads as '' — the
// sequence kinds' convention, so one client rule covers both. The `path`
// restriction compares the same spelling, so it can select that page too.
const PAGE_LABEL = "COALESCE(page.path, '')";

export function compileDwellQuery(
  query: DwellQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledLegs | CompileError {
  const scope = sessionScope('dwell queries', filters, windows);
  if ('error' in scope) return scope;

  const params = [...scope.params, PING_CLAMP_MS];
  const sql = [
    prefix(scope, [ORDERED_CTE, DWELL_CTE, SCROLL_CTE]),
    `SELECT ${PAGE_LABEL} AS path,`,
    '  COUNT(*) AS views_measured,',
    '  AVG(dwell.ms) AS avg_page_ms,',
    '  MAX(dwell.ms) AS max_page_ms,',
    // COUNT(expr) counts non-NULLs, and SQLite's AVG skips them — so a page leg
    // with no reading is left out of the average rather than dragging it toward
    // zero, and a corpus with no readings at all yields NULL instead of 0 %.
    '  COUNT(scroll.pct) AS views_scrolled,',
    '  AVG(scroll.pct) / 100.0 AS avg_scroll_pct',
    `FROM dwell ${pageJoin('dwell')}`,
    'LEFT JOIN scroll ON scroll.sid = dwell.sid AND scroll.page_idx = dwell.page_idx',
    ...pathRestriction(query.path, params),
    'GROUP BY 1',
    // Path breaks ties so a limited ranking is deterministic, like every other kind.
    'ORDER BY avg_page_ms DESC, path',
    'LIMIT ?',
  ].join('\n');
  params.push(query.limit);
  return { kind: 'dwell', sql, params, measures: DWELL_MEASURES };
}

/**
 * The duration bands the dwell histogram buckets legs into. A closed table, and
 * the labels are its own literals — never client input — so writing them into
 * the SQL text keeps invariant 9 intact, exactly like population.ts's hit types.
 */
const DWELL_BANDS = [
  { label: '0–10s', belowMs: 10_000 },
  { label: '10–30s', belowMs: 30_000 },
  { label: '30–60s', belowMs: 60_000 },
  { label: '1–3m', belowMs: 180_000 },
] as const;
const DWELL_OVERFLOW = '3m+';

export function compileDistributionQuery(
  query: DistributionQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledLegs | CompileError {
  const scope = sessionScope('distribution queries', filters, windows);
  if ('error' in scope) return scope;

  const params: (string | number)[] = [...scope.params];
  const legs = query.of;
  if (legs === 'dwell') params.push(PING_CLAMP_MS);
  // The scroll histogram never counts an unmeasured leg as 0: the scroll CTE
  // keeps only legs with a reading, the same honesty rule as `views_scrolled`.
  const bucket =
    legs === 'dwell'
      ? [
          'CASE',
          ...DWELL_BANDS.map((band) => `WHEN dwell.ms < ${band.belowMs} THEN '${band.label}'`),
          `ELSE '${DWELL_OVERFLOW}' END`,
        ].join(' ')
      : // Deciles 0–9; a full read (100 %) belongs to the last one, not a tenth.
        'MIN(scroll.pct / 10, 9)';
  const join = query.path === undefined ? [] : [pageJoin(legs)];
  const sql = [
    prefix(scope, legs === 'dwell' ? [ORDERED_CTE, DWELL_CTE] : [ORDERED_CTE, SCROLL_CTE]),
    `SELECT ${bucket} AS bucket, COUNT(*) AS legs`,
    `FROM ${legs}`,
    ...join,
    ...pathRestriction(query.path, params),
    'GROUP BY 1',
    // Band order is duration order; `MIN(ms)` recovers it without a rank column.
    legs === 'dwell' ? 'ORDER BY MIN(dwell.ms)' : 'ORDER BY 1',
  ].join('\n');
  return { kind: 'distribution', sql, params, measures: distributionMeasures(legs) };
}

/** `WITH bounds …, scoped AS (…)` plus the leg CTEs a kind actually reads. */
function prefix(scope: SessionScope, ctes: readonly string[]): string {
  return [`${scope.sql},`, ctes.join(',\n')].join('\n');
}

/** A leg selection, not a session filter: only legs on this page count. */
function pathRestriction(path: string | undefined, params: (string | number)[]): string[] {
  if (path === undefined) return [];
  params.push(path);
  return [`WHERE ${PAGE_LABEL} = ?`];
}
