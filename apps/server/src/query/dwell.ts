import {
  type DwellQuery,
  type FilterNode,
  type Measures,
  PING_CLAMP_MS,
  type SiteWindow,
} from '@featherstat/shared';
import type { CompileError } from './compiler.ts';
import { populationWhere } from './population.ts';
import { sessionScope } from './session-scope.ts';

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
 */

export interface CompiledDwell {
  kind: 'dwell';
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
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

export function compileDwellQuery(
  query: DwellQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledDwell | CompileError {
  const scope = sessionScope('dwell queries', filters, windows);
  if ('error' in scope) return scope;

  // The clamp is bound, never inlined — the same discipline as bounce_rate's threshold.
  const params = [...scope.params, PING_CLAMP_MS, query.limit];
  const sql = [
    `${scope.sql},`,
    'ordered AS (',
    '  SELECT e.session_id AS sid, e.ts AS ts, e.type AS type, e.path AS path,',
    '    e.scroll_pct AS scroll_pct,',
    `    SUM(CASE WHEN ${populationWhere('pageviews', 'e')} THEN 1 ELSE 0 END) OVER w AS page_idx,`,
    '    LEAD(e.ts) OVER w AS next_ts',
    '  FROM events e JOIN scoped ON e.session_id = scoped.sid',
    '  WINDOW w AS (PARTITION BY e.session_id ORDER BY e.seq)',
    '),',
    'dwell AS (',
    '  SELECT sid, page_idx, SUM(MIN(next_ts - ts, ?)) AS ms',
    '  FROM ordered WHERE next_ts IS NOT NULL AND page_idx > 0',
    '  GROUP BY sid, page_idx',
    '),',
    // Deliberately NOT filtered on next_ts, unlike `dwell` above. A page's
    // deepest reading arrives on its exit ping, which is the session's LAST row
    // and so has no next_ts; reading scroll under dwell's filter would return
    // the second-deepest reading of every page, every time — a bias that is
    // silent, systematic and always downward. Depth is a high-water mark, not a
    // gap: there is nothing unmeasurable about the last row's own reading.
    'scroll AS (',
    '  SELECT sid, page_idx, MAX(scroll_pct) AS pct',
    '  FROM ordered WHERE page_idx > 0 AND scroll_pct IS NOT NULL',
    '  GROUP BY sid, page_idx',
    ')',
    // NULL never labels a page: a title-only pageview (no URL) reads as '' — the
    // sequence kinds' convention, so one client rule covers both.
    "SELECT COALESCE(page.path, '') AS path,",
    '  COUNT(*) AS views_measured,',
    '  AVG(dwell.ms) AS avg_page_ms,',
    '  MAX(dwell.ms) AS max_page_ms,',
    // COUNT(expr) counts non-NULLs, and SQLite's AVG skips them — so a page leg
    // with no reading is left out of the average rather than dragging it toward
    // zero, and a corpus with no readings at all yields NULL instead of 0 %.
    '  COUNT(scroll.pct) AS views_scrolled,',
    '  AVG(scroll.pct) / 100.0 AS avg_scroll_pct',
    'FROM dwell JOIN ordered page',
    `  ON page.sid = dwell.sid AND page.page_idx = dwell.page_idx AND ${populationWhere('pageviews', 'page')}`,
    // Grouped, so at most one row per leg: it cannot fan out the counts above.
    'LEFT JOIN scroll ON scroll.sid = dwell.sid AND scroll.page_idx = dwell.page_idx',
    'GROUP BY 1',
    // Path breaks ties so a limited ranking is deterministic, like every other kind.
    'ORDER BY avg_page_ms DESC, path',
    'LIMIT ?',
  ].join('\n');
  return { kind: 'dwell', sql, params };
}
