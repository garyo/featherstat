import type { Migration } from '../migrate.ts';

/**
 * `local_hour` on sessions: the hour a visit STARTED, in the site's timezone —
 * exactly what `local_date` beside it already means, one grain finer (docs/03
 * § Timezones). Only `events` carried an hour before, so an hour bucket could
 * not reach a session metric at all and an intraday dashboard had no honest
 * bounce or engagement line (docs/05).
 *
 * The backfill reads the hour off each session's FIRST hit. A session starts
 * when that hit happens, so the two share an instant, and the ingest path
 * derives both from one `localClock` call — which makes this exact rather than
 * a re-derivation that could disagree about a DST edge. A session whose events
 * retention has already pruned keeps a NULL hour; it sits outside every window
 * that could ask for one.
 */
export const migration104: Migration = {
  version: 104,
  name: 'session-local-hour',
  sql: `
ALTER TABLE sessions ADD COLUMN local_hour INTEGER;

UPDATE sessions SET local_hour = (
  SELECT e.local_hour FROM events e
  WHERE e.session_id = sessions.id
  ORDER BY e.ts
  LIMIT 1
);
`,
};
