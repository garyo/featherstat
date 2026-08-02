import { beforeEach, describe, expect, it } from 'vitest';
import { binId, openTestDb, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  getSetting,
  insertEvents,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import type { AlertNotifier } from './alerts.ts';
import { DIGEST_LAST_RUN_KEY, DIGEST_TITLE, digestLastRunAt, runDigest } from './digest.ts';

/**
 * The weekly digest (docs/04 § 5) over independently known weeks. NOW is
 * 2026-07-27 14:00 UTC (= 10:00 EDT), so `7d` covers 2026-07-21..27 and its
 * previous window 2026-07-14..20 in both sites' timezone.
 *
 * Site one: 10 visits last week (all on /old), 12 this week (all on
 * /blog/foo) — up 20%, and /blog/foo is the mover. Site two: 5 visits each
 * week — steady. The sentences are golden: the digest and the MCP tool share
 * this formatter, so its exact phrasing is a contract.
 */

const NOW = Date.UTC(2026, 6, 27, 14);

let db: Db;
let posted: Array<{ key: string; title: string; body: string; cooldownMs: number | undefined }>;
let notify: AlertNotifier;
let nextId = 1;

function seedVisits(site: number, date: string, count: number, path: string): void {
  const ts = Date.parse(`${date}T15:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const id = binId(nextId++);
    insertEvents(db, [
      {
        site_id: site,
        ts,
        local_date: date,
        local_hour: 11,
        type: 'pageview',
        visitor_id: id,
        session_id: id,
        seq: 1,
        path,
      },
    ]);
    upsertSessions(db, [
      {
        id,
        site_id: site,
        visitor_id: id,
        started_at: ts,
        last_seen_at: ts,
        local_date: date,
        pageviews: 1,
        events: 0,
        engaged_ms: 0,
      },
    ]);
  }
}

beforeEach(() => {
  db = openTestDb(2);
  nextId = 1;
  withWriteTransaction(db, () => {
    seedVisits(1, '2026-07-15', 10, '/old');
    seedVisits(1, '2026-07-22', 12, '/blog/foo');
    seedVisits(2, '2026-07-15', 5, '/');
    seedVisits(2, '2026-07-22', 5, '/');
  });
  syncRollups(db);
  posted = [];
  notify = {
    configured: () => true,
    post: (key, title, body, cooldownMs) => {
      posted.push({ key, title, body, cooldownMs });
      return true;
    },
  };
});

describe('runDigest', () => {
  it('posts one notification with a golden sentence per site', () => {
    const result = runDigest(db, notify, { now: () => NOW });
    expect(result.skipped).toBe(false);
    expect(result.sites).toBe(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.key).toBe('digest');
    expect(posted[0]?.title).toBe(DIGEST_TITLE);
    const lines = posted[0]?.body.split('\n') ?? [];
    // Rising site: the movers come from the changes kind — /blog/foo carries
    // the story, the (none)-valued groups of the other dims ride behind it.
    expect(lines[0]).toBe(
      'one: visits up 20% (10 → 12) — /blog/foo (+12) and (none) (+2) drove it',
    );
    expect(lines[1]).toBe('two: steady (±0%)');
    db.close();
  });

  it('records its run in the settings row the scheduler reads', () => {
    expect(digestLastRunAt(db)).toBeUndefined();
    runDigest(db, notify, { now: () => NOW });
    expect(digestLastRunAt(db)).toBe(NOW);
    expect(getSetting(db, DIGEST_LAST_RUN_KEY)).toBe(String(NOW));
    db.close();
  });

  it('skips entirely — no queries, no run recorded — while ntfy is unconfigured', () => {
    const result = runDigest(db, { configured: () => false, post: () => true }, { now: () => NOW });
    expect(result).toEqual({ skipped: true, sites: 0, body: '' });
    expect(digestLastRunAt(db)).toBeUndefined();
    db.close();
  });
});
