import { type DwellQuery, type Filter, PING_CLAMP_MS } from '@featherstat/shared';
import type { CompileError } from './compiler.ts';
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

export function compileDwellQuery(
  query: DwellQuery,
  filters: readonly Filter[],
  siteCount: number,
): CompiledDwell | CompileError {
  const scope = sessionScope('dwell queries', filters, siteCount);
  if ('error' in scope) return scope;

  // The clamp is bound, never inlined — the same discipline as bounce_rate's threshold.
  const params = [...scope.params, PING_CLAMP_MS, query.limit];
  const sql = [
    `${scope.sql},`,
    'ordered AS (',
    '  SELECT e.session_id AS sid, e.ts AS ts, e.type AS type, e.path AS path,',
    "    SUM(CASE WHEN e.type = 'pageview' THEN 1 ELSE 0 END) OVER w AS page_idx,",
    '    LEAD(e.ts) OVER w AS next_ts',
    '  FROM events e JOIN scoped ON e.session_id = scoped.sid',
    '  WINDOW w AS (PARTITION BY e.session_id ORDER BY e.seq)',
    '),',
    'dwell AS (',
    '  SELECT sid, page_idx, SUM(MIN(next_ts - ts, ?)) AS ms',
    '  FROM ordered WHERE next_ts IS NOT NULL AND page_idx > 0',
    '  GROUP BY sid, page_idx',
    ')',
    // NULL never labels a page: a title-only pageview (no URL) reads as '' — the
    // sequence kinds' convention, so one client rule covers both.
    "SELECT COALESCE(page.path, '') AS path,",
    '  COUNT(*) AS views_measured,',
    '  AVG(dwell.ms) AS avg_page_ms,',
    '  MAX(dwell.ms) AS max_page_ms',
    'FROM dwell JOIN ordered page',
    "  ON page.sid = dwell.sid AND page.page_idx = dwell.page_idx AND page.type = 'pageview'",
    'GROUP BY 1',
    // Path breaks ties so a limited ranking is deterministic, like every other kind.
    'ORDER BY avg_page_ms DESC, path',
    'LIMIT ?',
  ].join('\n');
  return { kind: 'dwell', sql, params };
}
