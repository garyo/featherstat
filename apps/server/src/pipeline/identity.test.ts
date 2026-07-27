import type { Hit, HitContext } from '@analytics/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, getSetting, openDb, setSetting, withWriteTransaction } from '../db/index.ts';
import { Identity, uidEnabledKey } from './identity.ts';

const DAY1 = Date.UTC(2026, 6, 26, 12);
const DAY2 = Date.UTC(2026, 6, 27, 12);

function hit(overrides: Partial<Hit> = {}): Hit {
  return { siteId: 1, type: 'pageview', ...overrides };
}

function ctx(overrides: Partial<HitContext> = {}): HitContext {
  return { ip: '203.0.113.5', userAgent: 'Mozilla/5.0 test', receivedAt: DAY1, ...overrides };
}

function hex(id: Uint8Array): string {
  return Buffer.from(id).toString('hex');
}

let db: Db;
let identity: Identity;

beforeEach(() => {
  db = openDb(':memory:');
  identity = new Identity(db);
});

afterEach(() => {
  db.close();
});

describe('Identity', () => {
  it('produces 8 stable bytes for the same day, site, ip, and ua', () => {
    const a = identity.visitorId(hit(), ctx());
    const b = identity.visitorId(hit(), ctx());
    expect(a).toHaveLength(8);
    expect(hex(a)).toBe(hex(b));
  });

  it('persists the day salt so a restart yields the same ids', () => {
    const before = identity.visitorId(hit(), ctx());
    const after = new Identity(db).visitorId(hit(), ctx());
    expect(hex(after)).toBe(hex(before));
    expect(getSetting(db, 'salt:2026-07-26')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes ids when ip, ua, or site differ', () => {
    const base = hex(identity.visitorId(hit(), ctx()));
    expect(hex(identity.visitorId(hit(), ctx({ ip: '203.0.113.6' })))).not.toBe(base);
    expect(hex(identity.visitorId(hit(), ctx({ userAgent: 'other' })))).not.toBe(base);
    expect(hex(identity.visitorId(hit({ siteId: 2 }), ctx()))).not.toBe(base);
  });

  it('rotates the salt at the UTC day boundary and deletes prior salts', () => {
    const day1 = hex(identity.visitorId(hit(), ctx()));
    const day2 = hex(identity.visitorId(hit(), ctx({ receivedAt: DAY2 })));
    expect(day2).not.toBe(day1);
    expect(getSetting(db, 'salt:2026-07-26')).toBeUndefined();
    expect(getSetting(db, 'salt:2026-07-27')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('survives a backward clock step across UTC midnight without re-keying the day', () => {
    identity.visitorId(hit(), ctx()); // day 1 salt exists, then…
    const day2 = hex(identity.visitorId(hit(), ctx({ receivedAt: DAY2 }))); // …rotation deletes it
    // NTP steps the clock back before midnight: rotation is forward-only, so
    // the current salt survives and the visitor keeps one id for the day.
    expect(hex(identity.visitorId(hit(), ctx()))).toBe(day2);
    expect(getSetting(db, 'salt:2026-07-27')).toMatch(/^[0-9a-f]{32}$/);
    expect(hex(identity.visitorId(hit(), ctx({ receivedAt: DAY2 })))).toBe(day2);
  });

  it('never deletes a newer day salt when restarted under a regressed clock', () => {
    const day2 = hex(identity.visitorId(hit(), ctx({ receivedAt: DAY2 })));
    const salt = getSetting(db, 'salt:2026-07-27');
    new Identity(db).visitorId(hit(), ctx()); // boots on day 1 again, re-mints its salt
    expect(getSetting(db, 'salt:2026-07-27')).toBe(salt);
    expect(hex(new Identity(db).visitorId(hit(), ctx({ receivedAt: DAY2 })))).toBe(day2);
  });

  it('lets a Matomo _id replace the ip∥ua fingerprint input', () => {
    const a = identity.visitorId(hit({ visitorId: 'abcdef0123456789' }), ctx());
    const b = identity.visitorId(
      hit({ visitorId: 'abcdef0123456789' }),
      ctx({ ip: '198.51.100.7', userAgent: 'entirely different' }),
    );
    expect(hex(a)).toBe(hex(b));
    // …but the daily rotation still applies to _id-based ids.
    const c = identity.visitorId(hit({ visitorId: 'abcdef0123456789' }), ctx({ receivedAt: DAY2 }));
    expect(hex(c)).not.toBe(hex(a));
  });

  it('ignores uid for sites that never opted in (docs/03: off by default)', () => {
    const withUid = hex(identity.visitorId(hit({ uid: 'gary' }), ctx()));
    expect(withUid).toBe(hex(identity.visitorId(hit(), ctx())));
    expect(getSetting(db, 'uidsalt:1')).toBeUndefined();
    // …so a uid cannot defeat the daily rotation for a non-opted-in site.
    expect(hex(identity.visitorId(hit({ uid: 'gary' }), ctx({ receivedAt: DAY2 })))).not.toBe(
      withUid,
    );
  });

  it('hashes uid with a stable per-site salt for opted-in sites, surviving day rotation', () => {
    withWriteTransaction(db, () => {
      setSetting(db, uidEnabledKey(1), '1');
      setSetting(db, uidEnabledKey(2), '1');
    });
    const a = identity.visitorId(hit({ uid: 'gary' }), ctx());
    const b = identity.visitorId(
      hit({ uid: 'gary' }),
      ctx({ receivedAt: DAY2, ip: '198.51.100.7' }),
    );
    expect(hex(b)).toBe(hex(a));
    expect(getSetting(db, 'uidsalt:1')).toMatch(/^[0-9a-f]{32}$/);
    // Per-site salt: the same uid on another site is a different visitor.
    expect(hex(identity.visitorId(hit({ uid: 'gary', siteId: 2 }), ctx()))).not.toBe(hex(a));
    // Salt persists across restarts.
    expect(hex(new Identity(db).visitorId(hit({ uid: 'gary' }), ctx()))).toBe(hex(a));
  });
});
