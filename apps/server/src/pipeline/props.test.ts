import { PROP_VALUE_OTHER, PROP_VALUES_PER_KEY, type Props } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb } from '../../test/rows.ts';
import { type Db, listPropDrops, listPropKeys, stmt, withWriteTransaction } from '../db/index.ts';
import { WriteBatcher } from './batcher.ts';
import { PropRegistry } from './props.ts';

const DATE = '2026-07-27';
const NOW = 1_753_624_800_000;

let db: Db;
let registry: PropRegistry;

beforeEach(() => {
  db = openTestDb();
  registry = new PropRegistry(db);
});

afterEach(() => {
  db.close();
});

const admit = (
  props: Props,
  type: Parameters<PropRegistry['admit']>[3] = 'pageview',
): string | undefined => registry.admit(1, props, DATE, type, NOW);

/** Land the queued deltas the way the batcher does: apply inside a txn, then commit. */
function flush(): void {
  withWriteTransaction(db, () => registry.apply(db));
  registry.committed();
}

function drops(): Record<string, number> {
  flush();
  const counts: Record<string, number> = {};
  for (const row of listPropDrops(db, 1, DATE)) counts[row.reason] = row.count;
  return counts;
}

describe('admit', () => {
  it('returns canonical JSON: sorted keys, no whitespace, JSON types preserved', () => {
    expect(admit({ plan: 'pro', beta: true, seats: 3 })).toBe(
      '{"beta":true,"plan":"pro","seats":3}',
    );
  });

  it('returns nothing for an empty bag — {} is never stored', () => {
    expect(admit({})).toBeUndefined();
  });

  it('strips a bag riding a ping and counts it, because a ping bag is a tracker bug', () => {
    expect(admit({ plan: 'pro' }, 'ping')).toBeUndefined();
    expect(drops()).toEqual({ on_ping: 1 });
  });

  it('drops a key outside the charset — the Hit-level bypass the schema cannot see', () => {
    expect(admit({ 'Bad Key': 'x', ok: 'y' })).toBe('{"ok":"y"}');
    expect(drops()).toEqual({ bad_key: 1 });
  });

  it('drops an IP-shaped value with its key (invariant 3 posture)', () => {
    expect(admit({ v4: '203.0.113.9', v6: '2001:db8::1', ok: 'kept' })).toBe('{"ok":"kept"}');
    expect(drops()).toEqual({ ip_shaped: 2 });
  });

  it('drops an over-long string value with its key', () => {
    expect(admit({ big: 'x'.repeat(201), ok: 'y' })).toBe('{"ok":"y"}');
    expect(drops()).toEqual({ oversize: 1 });
  });

  it('keeps the first 10 props in sorted key order past the per-event cap', () => {
    const bag: Props = {};
    for (let i = 20; i >= 1; i--) bag[`k${String(i).padStart(2, '0')}`] = i;
    const stored = JSON.parse(admit(bag) ?? '{}') as Props;
    expect(Object.keys(stored)).toEqual(
      Array.from({ length: 10 }, (_, i) => `k${String(i + 1).padStart(2, '0')}`),
    );
    expect(drops()).toEqual({ oversize: 1 });
  });

  it('drops a bag whose canonical JSON exceeds the byte cap', () => {
    expect(admit({ a: 'x'.repeat(200), b: 'x'.repeat(200) })).toContain('"a"'); // under
    expect(
      admit({
        a: 'x'.repeat(200),
        b: 'x'.repeat(200),
        c: 'x'.repeat(200),
        d: 'x'.repeat(200),
        e: 'x'.repeat(200),
      }),
    ).toBeUndefined();
    expect(drops()).toEqual({ oversize: 1 });
  });

  it('drops a NEW key once the site holds 30, keeping the known ones', () => {
    for (let i = 1; i <= 30; i++) admit({ [`k${String(i).padStart(2, '0')}`]: 'v' });
    expect(admit({ k01: 'again', k31: 'new' })).toBe('{"k01":"again"}');
    expect(drops()).toEqual({ too_many_keys: 1 });
  });

  it('clamps a NEW value past 500 to the sentinel and records when the cap engaged', () => {
    for (let i = 0; i < PROP_VALUES_PER_KEY; i++) admit({ plan: `v${i}` });
    expect(admit({ plan: 'v1' })).toBe('{"plan":"v1"}'); // known value: untouched
    expect(admit({ plan: 'one-too-many' })).toBe(`{"plan":"${PROP_VALUE_OTHER}"}`);
    expect(drops()).toEqual({ value_clamped: 1 });
    const [key] = listPropKeys(db, 1);
    expect(key?.distinct_values).toBe(PROP_VALUES_PER_KEY);
    expect(key?.over_cap_since).toBe(NOW);
  });

  it('tells true and "true" apart when counting distinct values', () => {
    admit({ flag: true });
    admit({ flag: 'true' });
    flush();
    expect(listPropKeys(db, 1)[0]?.distinct_values).toBe(2);
  });
});

describe('durable registry state', () => {
  it('books events, last_seen and values through the flush; a fresh registry reloads them', () => {
    admit({ plan: 'pro' });
    admit({ plan: 'free', beta: true });
    flush();

    const keys = listPropKeys(db, 1);
    expect(keys.map((k) => [k.key, k.events, k.distinct_values])).toEqual([
      ['beta', 1, 1],
      ['plan', 2, 2],
    ]);
    expect(keys[1]?.first_seen).toBe(NOW);
    expect(keys[1]?.last_seen).toBe(NOW);

    // The tables are the truth a restart reloads: the reloaded registry still
    // knows both values of 'plan', so re-admitting one adds no distinct value.
    const reloaded = new PropRegistry(db);
    reloaded.admit(1, { plan: 'pro' }, DATE, 'event', NOW + 1);
    withWriteTransaction(db, () => reloaded.apply(db));
    reloaded.committed();
    const after = listPropKeys(db, 1);
    expect(after[1]?.distinct_values).toBe(2);
    expect(after[1]?.events).toBe(3);
    expect(after[1]?.last_seen).toBe(NOW + 1);
  });

  it('deleteKey forgets memory, deltas and rows; the key returns as brand new', () => {
    admit({ plan: 'pro' });
    flush();
    admit({ plan: 'free' }); // queued, not yet flushed
    const existed = withWriteTransaction(db, () => registry.deleteKey(1, 'plan'));
    expect(existed).toBe(true);
    flush();
    expect(listPropKeys(db, 1)).toEqual([]);
    expect(stmt(db, 'SELECT COUNT(*) FROM prop_values').pluck().get()).toBe(0);
    expect(withWriteTransaction(db, () => registry.deleteKey(1, 'plan'))).toBe(false);
  });
});

describe('riding the batcher flush (invariant 2)', () => {
  it('lands registry writes in the SAME transaction as the events, and retries as one', () => {
    const batcher = new WriteBatcher(db, 60_000, registry);
    batcher.addEvent(event({ props: admit({ plan: 'pro' }) }));

    // First attempt fails after every write: both the event and the registry
    // rows must roll back together, and the retry must not double-count.
    batcher.beforeCommit = () => {
      throw new Error('boom');
    };
    expect(batcher.flush()).toBeUndefined();
    expect(stmt(db, 'SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    expect(listPropKeys(db, 1)).toEqual([]);

    batcher.beforeCommit = undefined;
    expect(batcher.flush()?.events).toBe(1);
    expect(stmt(db, 'SELECT props FROM events').pluck().get()).toBe('{"plan":"pro"}');
    expect(listPropKeys(db, 1).map((k) => [k.key, k.events])).toEqual([['plan', 1]]);
  });

  it('flushes a drop counter even when no event rode with it (an orphan ping bag)', () => {
    const batcher = new WriteBatcher(db, 60_000, registry);
    admit({ plan: 'pro' }, 'ping');
    expect(batcher.pending).toBe(1);
    batcher.flush();
    expect(listPropDrops(db, 1, DATE)).toEqual([{ local_date: DATE, reason: 'on_ping', count: 1 }]);
  });
});
