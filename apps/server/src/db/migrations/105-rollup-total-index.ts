import type { Migration } from '../migrate.ts';

/**
 * Covering indexes for the undimensioned rollup rows (docs/03 § Rollups). The
 * EAV tables' primary keys lead with `(site_id, local_date, dim_id, …)` — the
 * write path's order, so a flush or a day rebuild touches one contiguous range
 * — but a read asks for ONE `dim_id` across a date range, and on that key it
 * walks every dimension's rows of every day to find its own. The commonest
 * read is `dim_id = 0`, the totals behind every KPI tile, sparkline and time
 * series: one row per site-day buried among ~twenty dimensions' rows.
 *
 * A partial index over just those rows, carrying their counters, answers that
 * read without touching the table (on the 90-day seed, a 90-day total went
 * from 1.8 ms to 0.05 ms). It holds one entry per site-day, so it costs almost
 * nothing to store or to keep current.
 *
 * The per-dimension reads are deliberately left on the primary key. An index
 * serving them from its own pages must carry the counters every flush
 * rewrites, which doubles the tables and adds an index write per upsert on
 * the ingest path; a narrow `(site_id, dim_id, local_date)` index cost ~6% in
 * bytes per event and ~10% in flush time for no measurable change in any
 * dashboard batch the replay bench runs.
 */
export const migration105: Migration = {
  version: 105,
  name: 'rollup-total-index',
  sql: `
CREATE INDEX ix_rollup_dim_day_total ON rollup_dim_day (
  site_id, local_date,
  hits, actions, pageviews, events, outlinks, downloads, event_value_sum,
  visitors, sessions_touched
) WHERE dim_id = 0;

CREATE INDEX ix_rollup_sessions_day_total ON rollup_sessions_day (
  site_id, local_date,
  visits, measured_sessions, engaged_ms, bounced, session_pageviews
) WHERE dim_id = 0;
`,
};
