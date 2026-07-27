import type { EventRow, SessionRow } from '../src/db/index.ts';

/** Fixtures shared by the server test suites — one copy of every row factory. */

export const VISITOR = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
export const SESSION = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);

/** 2026-07-27 14:00 UTC = 10:00 EDT. */
export const T0 = Date.UTC(2026, 6, 27, 14);

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** 2023-11-14 17:33 UTC — an arbitrary fixed instant for row-level tests. */
const TS = 1_700_000_000_000;

export function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    site_id: 1,
    ts: TS,
    local_date: '2023-11-14',
    local_hour: 17,
    type: 'pageview',
    visitor_id: VISITOR,
    session_id: SESSION,
    seq: 1,
    ...overrides,
  };
}

export function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION,
    site_id: 1,
    visitor_id: VISITOR,
    started_at: TS,
    last_seen_at: TS,
    local_date: '2023-11-14',
    pageviews: 1,
    events: 0,
    engaged_ms: 0,
    ...overrides,
  };
}
