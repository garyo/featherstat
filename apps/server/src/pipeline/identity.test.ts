import type { Hit, HitContext } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, getSetting, openDb, setSetting, withWriteTransaction } from '../db/index.ts';
import { carryDaySalt, Identity, uidEnabledKey } from './identity.ts';

/** Midday in New York on two consecutive site-local days. */
const DAY1 = Date.UTC(2026, 6, 26, 16);
const DAY2 = Date.UTC(2026, 6, 27, 16);
/** 21:00 in New York on day 1: past UTC midnight, still the same site-local day. */
const DAY1_EVENING = Date.UTC(2026, 6, 27, 1);

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

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

/** The zone is the third argument everywhere; most cases only care about one. */
function id(hitOverrides: Partial<Hit>, ctxOverrides: Partial<HitContext>, zone = NY): string {
  return hex(identity.visitorId(hit(hitOverrides), ctx(ctxOverrides), zone));
}

beforeEach(() => {
  db = openDb(':memory:');
  identity = new Identity(db);
});

afterEach(() => {
  db.close();
});

describe('Identity', () => {
  it('produces 8 stable bytes for the same day, site, ip, and ua', () => {
    const a = identity.visitorId(hit(), ctx(), NY);
    expect(a).toHaveLength(8);
    expect(hex(a)).toBe(id({}, {}));
  });

  it('persists the day salt so a restart yields the same ids', () => {
    const before = id({}, {});
    expect(hex(new Identity(db).visitorId(hit(), ctx(), NY))).toBe(before);
    expect(getSetting(db, `salt:${NY}:2026-07-26`)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes ids when ip, ua, or site differ', () => {
    const base = id({}, {});
    expect(id({}, { ip: '203.0.113.6' })).not.toBe(base);
    expect(id({}, { userAgent: 'other' })).not.toBe(base);
    expect(id({ siteId: 2 }, {})).not.toBe(base);
  });

  it('rotates at site-local midnight, not UTC midnight', () => {
    // 21:00 local is already tomorrow in UTC. The visitor keeps one id through it,
    // because the boundary that matters is the one `local_date` is bucketed on.
    const midday = id({}, {});
    expect(id({}, { receivedAt: DAY1_EVENING })).toBe(midday);
    expect(id({}, { receivedAt: DAY2 })).not.toBe(midday);
  });

  it('keys the salt by timezone: same zone shares a row, other zones do not', () => {
    // One Tokyo row and one New York row, and their ids differ even for one site
    // — the same instant is a different local day in the two zones.
    const ny = id({}, {});
    expect(id({}, {}, TOKYO)).not.toBe(ny);
    expect(getSetting(db, `salt:${NY}:2026-07-26`)).toMatch(/^[0-9a-f]{32}$/);
    expect(getSetting(db, `salt:${TOKYO}:2026-07-27`)).toMatch(/^[0-9a-f]{32}$/);
    // site_id is inside the hash, so two sites sharing a zone share the salt row
    // without sharing ids.
    expect(id({ siteId: 2 }, {})).not.toBe(ny);
    expect(settingKeys()).toEqual([`salt:${NY}:2026-07-26`, `salt:${TOKYO}:2026-07-27`]);
  });

  it("deletes the zone's prior salts and never a sibling zone's", () => {
    id({}, {}, TOKYO);
    id({}, {});
    id({}, { receivedAt: DAY2 });
    expect(getSetting(db, `salt:${NY}:2026-07-26`)).toBeUndefined();
    expect(getSetting(db, `salt:${NY}:2026-07-27`)).toMatch(/^[0-9a-f]{32}$/);
    expect(getSetting(db, `salt:${TOKYO}:2026-07-27`)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('destroys a salt left behind by the UTC-keyed scheme', () => {
    // Rotation used to key on the UTC date alone. Nothing reads those rows now,
    // and a salt nothing reads is a secret that could relink a day of hashes.
    withWriteTransaction(db, () => {
      setSetting(db, 'salt:2026-07-25', 'ff'.repeat(16));
    });
    id({}, {});
    expect(getSetting(db, 'salt:2026-07-25')).toBeUndefined();
    expect(settingKeys()).toEqual([`salt:${NY}:2026-07-26`]);
  });

  it('survives a backward clock step across local midnight without re-keying the day', () => {
    id({}, {}); // day 1 salt exists, then…
    const day2 = id({}, { receivedAt: DAY2 }); // …rotation deletes it
    // NTP steps the clock back before midnight: rotation is forward-only, so
    // the current salt survives and the visitor keeps one id for the day.
    expect(id({}, {})).toBe(day2);
    expect(getSetting(db, `salt:${NY}:2026-07-27`)).toMatch(/^[0-9a-f]{32}$/);
    expect(id({}, { receivedAt: DAY2 })).toBe(day2);
  });

  it('never deletes a newer day salt when restarted under a regressed clock', () => {
    const day2 = id({}, { receivedAt: DAY2 });
    const salt = getSetting(db, `salt:${NY}:2026-07-27`);
    new Identity(db).visitorId(hit(), ctx(), NY); // boots on day 1 again, re-mints its salt
    expect(getSetting(db, `salt:${NY}:2026-07-27`)).toBe(salt);
    expect(hex(new Identity(db).visitorId(hit(), ctx({ receivedAt: DAY2 }), NY))).toBe(day2);
  });

  it('rotates once across a spring-forward that skips 02:00 (America/New_York)', () => {
    // 2026-03-08: 01:59 EST → 03:00 EDT. Local midnight exists, so the boundary
    // is where it always is and the day either side of it is one salt.
    const before = Date.UTC(2026, 2, 8, 4, 30); // 23:30 on the 7th, EST
    const across = Date.UTC(2026, 2, 8, 8, 30); // 04:30 on the 8th, EDT
    const later = Date.UTC(2026, 2, 8, 20, 0); // 16:00 on the 8th, EDT
    const day7 = id({}, { receivedAt: before });
    const day8 = id({}, { receivedAt: across });
    expect(day8).not.toBe(day7);
    expect(id({}, { receivedAt: later })).toBe(day8);
    expect(settingKeys()).toEqual([`salt:${NY}:2026-03-08`]);
  });

  it('degrades forward-only where a DST shift repeats local midnight (America/Havana)', () => {
    // Cuba ends DST at 01:00 local, stepping the clock back to 00:00 — so the
    // first hour of 2025-11-02 is lived twice and its local date goes 11-02,
    // 11-02 again. Nothing regresses (a repeat is not a step back to the 1st),
    // so one salt covers the doubled hour and the visitor keeps one id.
    const havana = 'America/Havana';
    const firstMidnight = Date.UTC(2025, 10, 2, 4, 30); // 00:30 CDT
    const repeated = Date.UTC(2025, 10, 2, 5, 30); // 00:30 again, CST
    const before = id({}, { receivedAt: Date.UTC(2025, 10, 2, 3, 30) }, havana); // 23:30 on the 1st
    const first = id({}, { receivedAt: firstMidnight }, havana);
    expect(first).not.toBe(before);
    expect(id({}, { receivedAt: repeated }, havana)).toBe(first);
    expect(settingKeys()).toEqual([`salt:${havana}:2025-11-02`]);
  });

  it('rotates on the date where a DST shift skips local midnight (America/Santiago)', () => {
    // Chile starts DST at 24:00, so 2025-09-07 has no 00:xx at all: 23:30 on the
    // 6th is followed by 01:30 on the 7th. The salt keys on the DATE, which still
    // advances, so the missing hour costs nothing.
    const santiago = 'America/Santiago';
    const before = id({}, { receivedAt: Date.UTC(2025, 8, 7, 3, 30) }, santiago); // 23:30 on the 6th
    const after = id({}, { receivedAt: Date.UTC(2025, 8, 7, 4, 30) }, santiago); // 01:30 on the 7th
    expect(after).not.toBe(before);
    expect(id({}, { receivedAt: Date.UTC(2025, 8, 7, 16, 0) }, santiago)).toBe(after);
    expect(settingKeys()).toEqual([`salt:${santiago}:2025-09-07`]);
  });

  it('lets a Matomo _id replace the ip∥ua fingerprint input', () => {
    const a = id({ visitorId: 'abcdef0123456789' }, {});
    const b = id(
      { visitorId: 'abcdef0123456789' },
      { ip: '198.51.100.7', userAgent: 'entirely different' },
    );
    expect(b).toBe(a);
    // …but the daily rotation still applies to _id-based ids.
    expect(id({ visitorId: 'abcdef0123456789' }, { receivedAt: DAY2 })).not.toBe(a);
  });

  it('ignores uid for sites that never opted in (docs/03: off by default)', () => {
    const withUid = id({ uid: 'gary' }, {});
    expect(withUid).toBe(id({}, {}));
    expect(getSetting(db, 'uidsalt:1')).toBeUndefined();
    // …so a uid cannot defeat the daily rotation for a non-opted-in site.
    expect(id({ uid: 'gary' }, { receivedAt: DAY2 })).not.toBe(withUid);
  });

  it('hashes uid with a stable per-site salt for opted-in sites, surviving day rotation', () => {
    withWriteTransaction(db, () => {
      setSetting(db, uidEnabledKey(1), '1');
      setSetting(db, uidEnabledKey(2), '1');
    });
    const a = id({ uid: 'gary' }, {});
    expect(id({ uid: 'gary' }, { receivedAt: DAY2, ip: '198.51.100.7' })).toBe(a);
    expect(getSetting(db, 'uidsalt:1')).toMatch(/^[0-9a-f]{32}$/);
    // Per-site salt: the same uid on another site is a different visitor, and the
    // zone plays no part in it — that is what "stable" means here.
    expect(id({ uid: 'gary', siteId: 2 }, {})).not.toBe(a);
    expect(id({ uid: 'gary' }, {}, TOKYO)).toBe(a);
    // Salt persists across restarts.
    expect(hex(new Identity(db).visitorId(hit({ uid: 'gary' }), ctx(), NY))).toBe(a);
  });
});

/** Every day-salt row currently held, so a rotation's deletions are visible whole. */
function settingKeys(): string[] {
  return db
    .prepare("SELECT key FROM settings WHERE key LIKE 'salt:%' ORDER BY key")
    .pluck()
    .all() as string[];
}

describe('carryDaySalt (a site changing timezone)', () => {
  const LONDON = 'Europe/London';

  it("keeps the site's visitors on their ids for the rest of the new zone's day", () => {
    const before = id({}, {}); // seen today in New York
    withWriteTransaction(db, () => carryDaySalt(db, NY, TOKYO, DAY1));
    expect(getSetting(db, `salt:${TOKYO}:2026-07-27`)).toBe(
      getSetting(db, `salt:${NY}:2026-07-26`),
    );
    expect(id({}, {}, TOKYO)).toBe(before);
  });

  it('never replaces a salt the new zone already minted — other sites hold ids under it', () => {
    const london = id({ siteId: 2 }, {}, LONDON);
    const minted = getSetting(db, `salt:${LONDON}:2026-07-26`);
    id({}, {});
    withWriteTransaction(db, () => carryDaySalt(db, NY, LONDON, DAY1));
    expect(getSetting(db, `salt:${LONDON}:2026-07-26`)).toBe(minted);
    expect(id({ siteId: 2 }, {}, LONDON)).toBe(london);
  });

  it("clears the new zone's older salts, as its own rotation would have", () => {
    withWriteTransaction(db, () => setSetting(db, `salt:${TOKYO}:2026-07-20`, 'ee'.repeat(16)));
    id({}, {});
    withWriteTransaction(db, () => carryDaySalt(db, NY, TOKYO, DAY1));
    expect(getSetting(db, `salt:${TOKYO}:2026-07-20`)).toBeUndefined();
  });

  it('does nothing when the old zone has no live salt', () => {
    withWriteTransaction(db, () => carryDaySalt(db, NY, TOKYO, DAY1));
    expect(getSetting(db, `salt:${TOKYO}:2026-07-27`)).toBeUndefined();
  });
});
