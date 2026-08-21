import type { AlertRule } from '@featherstat/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { binId, openTestDb, syncRollups } from '../../test/rows.ts';
import {
  type Db,
  type EventRow,
  insertEvents,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { type AlertNotifier, readAlertRules, runAlerts, writeAlertRules } from './alerts.ts';

/**
 * Alert evaluation (docs/04 § 5) over a tiny fixed corpus: site 1
 * (America/New_York) with 3 pageviews today and 6 yesterday, so `today` totals
 * and `previous` comparisons are independently known. NOW is 2026-07-27 14:00
 * UTC = 10:00 EDT; "today" is 2026-07-27, "yesterday" 2026-07-26.
 */

const NOW = Date.UTC(2026, 6, 27, 14);

let db: Db;
let posted: Array<{ key: string; title: string; body: string; cooldownMs: number | undefined }>;
let notify: AlertNotifier;
let nextId = 1;

function seedDay(date: string, hour: number, count: number, over: Partial<EventRow> = {}): void {
  const ts = Date.parse(`${date}T${String(hour + 4).padStart(2, '0')}:00:00Z`); // EDT = UTC−4
  for (let i = 0; i < count; i += 1) {
    const id = binId(nextId++);
    insertEvents(db, [
      {
        site_id: 1,
        ts,
        local_date: date,
        local_hour: hour,
        type: 'pageview',
        visitor_id: id,
        session_id: id,
        seq: 1,
        ...over,
      },
    ]);
    upsertSessions(db, [
      {
        id,
        site_id: 1,
        visitor_id: id,
        started_at: ts,
        last_seen_at: ts,
        local_date: date,
        local_hour: hour,
        pageviews: 1,
        events: 0,
        engaged_ms: 0,
        country: over.country ?? null,
      },
    ]);
  }
}

beforeEach(() => {
  db = openTestDb();
  nextId = 1;
  withWriteTransaction(db, () => {
    seedDay('2026-07-27', 9, 3, { country: 'US' });
    seedDay('2026-07-26', 9, 6, { country: 'US' });
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

function setRules(rules: AlertRule[]): void {
  withWriteTransaction(db, () => writeAlertRules(db, rules));
}

const base = { site: 1, metric: 'pageviews', window: 'day' } as const;

describe('runAlerts', () => {
  it('skips entirely while ntfy is unconfigured', () => {
    setRules([{ ...base, condition: 'above', threshold: 0 }]);
    const idle = runAlerts(db, { configured: () => false, post: () => true }, { now: () => NOW });
    expect(idle).toEqual({ evaluated: 0, fired: 0, skipped: true });
    db.close();
  });

  it('fires above/below on the current total, holding when the rule holds', () => {
    setRules([
      { ...base, condition: 'above', threshold: 2 }, // 3 > 2 → fires
      { ...base, condition: 'above', threshold: 3 }, // 3 > 3 is false → holds
      { ...base, condition: 'below', threshold: 5 }, // 3 < 5 → fires
      { ...base, condition: 'below', threshold: 3 }, // holds
    ]);
    const result = runAlerts(db, notify, { now: () => NOW });
    expect(result).toMatchObject({ evaluated: 4, fired: 2, skipped: false });
    expect(posted[0]?.title).toBe('one: pageviews alert');
    expect(posted[0]?.body).toBe('pageviews is 3, above 2 (today so far)');
    expect(posted[1]?.body).toBe('pageviews is 3, below 5 (today so far)');
    db.close();
  });

  it('fires delta_pct on the absolute percent change vs the previous window', () => {
    setRules([
      { ...base, condition: 'delta_pct', threshold: 40 }, // 3 vs 6 = −50% → fires
      { ...base, condition: 'delta_pct', threshold: 60 }, // |−50| < 60 → holds
    ]);
    const result = runAlerts(db, notify, { now: () => NOW });
    expect(result.fired).toBe(1);
    expect(posted[0]?.body).toBe('pageviews down 50% (6 → 3, today so far)');
    db.close();
  });

  it('narrows by dim=value with an ordinary eq filter', () => {
    setRules([
      { ...base, dim: 'country', value: 'US', condition: 'above', threshold: 2 }, // 3 → fires
      { ...base, dim: 'country', value: 'DE', condition: 'above', threshold: 0 }, // 0 → holds
    ]);
    const result = runAlerts(db, notify, { now: () => NOW });
    expect(result.fired).toBe(1);
    expect(posted[0]?.body).toContain('for country=US');
    db.close();
  });

  it('posts under a stable per-rule key with the alert cooldown', () => {
    setRules([{ ...base, condition: 'above', threshold: 0 }]);
    runAlerts(db, notify, { now: () => NOW });
    runAlerts(db, notify, { now: () => NOW });
    expect(posted).toHaveLength(2);
    expect(posted[0]?.key).toBe(posted[1]?.key);
    expect(posted[0]?.key).toMatch(/^alert:/);
    expect(posted[0]?.cooldownMs).toBeGreaterThan(0);
    db.close();
  });

  it('never alerts from a refused query — a bad shape holds, not pages', () => {
    // bounce_rate × an event-only dimension is an honest per-query refusal.
    setRules([
      {
        site: 1,
        metric: 'bounce_rate',
        dim: 'title',
        value: 'x',
        condition: 'above',
        threshold: 0,
        window: 'day',
      },
    ]);
    const result = runAlerts(db, notify, { now: () => NOW });
    expect(result.fired).toBe(0);
    db.close();
  });

  it('fails closed on an unreadable rules row', () => {
    withWriteTransaction(db, () => writeAlertRules(db, []));
    withWriteTransaction(db, () => {
      // Corrupt the row directly — a stored settings row is a boundary too.
      db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'alert_rules'").run();
    });
    expect(readAlertRules(db, () => {})).toEqual([]);
    db.close();
  });
});
