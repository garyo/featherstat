import {
  ENGAGEMENT_THRESHOLD_MS,
  type Hit,
  PING_CLAMP_MS,
  SESSION_TIMEOUT_MS,
} from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { T0, VISITOR } from '../../test/rows.ts';
import {
  insertEvents,
  openDb,
  type Site,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import type { DeviceInfo } from './enrich.ts';
import type { SessionizerInput } from './sessionizer.ts';
import { loadOpenSessions, localParts, Sessionizer } from './sessionizer.ts';

const SITE: Site = {
  id: 1,
  name: 'Example',
  domains: ['example.com', 'www.example.com'],
  timezone: 'America/New_York',
  created_at: 0,
};

const DEVICE: DeviceInfo = {
  browser: 'Chrome',
  browser_version: '126.0.0.0',
  os: 'Windows',
  device_type: 'desktop',
};

function run(
  sessionizer: Sessionizer,
  now: number,
  hit: Partial<Hit> = {},
  input: Partial<Omit<SessionizerInput, 'hit' | 'now'>> = {},
) {
  return sessionizer.process({
    site: SITE,
    hit: { siteId: 1, type: 'pageview', url: 'https://example.com/a', ...hit },
    visitorId: VISITOR,
    now,
    device: DEVICE,
    geo: null,
    lang: 'en-US',
    ...input,
  });
}

describe('session lifecycle', () => {
  it('starts a session on the first hit', () => {
    const s = new Sessionizer();
    const { event, session } = run(s, T0);
    expect(session.id).toHaveLength(8);
    expect(session.visitor_id).toBe(VISITOR);
    expect(session.started_at).toBe(T0);
    expect(session.last_seen_at).toBe(T0);
    expect(session.local_date).toBe('2026-07-27');
    expect(session.entry_path).toBe('/a');
    expect(session.exit_path).toBe('/a');
    expect(session.pageviews).toBe(1);
    expect(session.events).toBe(0);
    expect(session.engaged_ms).toBe(0);
    expect(session.browser).toBe('Chrome');
    expect(session.device_type).toBe('desktop');
    expect(event.session_id).toBe(session.id);
    expect(event.seq).toBe(1);
    expect(event.type).toBe('pageview');
    expect(event.hostname).toBe('example.com');
    expect(event.path).toBe('/a');
    expect(event.local_date).toBe('2026-07-27');
    expect(event.local_hour).toBe(10);
  });

  it('continues within the timeout: same id, seq increments, engagement accrues', () => {
    const s = new Sessionizer();
    const first = run(s, T0);
    const second = run(s, T0 + 5_000, { url: 'https://example.com/b' });
    expect(second.session.id).toBe(first.session.id);
    expect(second.event.seq).toBe(2);
    expect(second.session.pageviews).toBe(2);
    expect(second.session.engaged_ms).toBe(5_000);
    expect(second.session.last_seen_at).toBe(T0 + 5_000);
    expect(second.session.exit_path).toBe('/b');
    expect(second.session.entry_path).toBe('/a');
  });

  it('continues at exactly the timeout, rolls over just past it', () => {
    const s = new Sessionizer();
    const first = run(s, T0);
    const atLimit = run(s, T0 + SESSION_TIMEOUT_MS);
    expect(atLimit.session.id).toBe(first.session.id);
    // The gap is measured from last_seen_at, i.e. from atLimit's hit.
    const past = run(s, T0 + 2 * SESSION_TIMEOUT_MS + 1);
    expect(past.session.id).not.toBe(first.session.id);
  });

  it('evicts sessions past the idle timeout so the open map cannot grow forever', () => {
    const s = new Sessionizer();
    run(s, T0);
    expect(s.size).toBe(1);
    const other = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
    run(s, T0 + 2 * SESSION_TIMEOUT_MS, {}, { visitorId: other });
    expect(s.size).toBe(1); // the expired session was swept, not retained alongside
  });

  it('rolls over after idle timeout with fresh counters, seq, and attribution', () => {
    const s = new Sessionizer();
    const first = run(s, T0, { referrer: 'https://www.google.com/' });
    expect(first.session.ref_type).toBe('search');
    const later = T0 + SESSION_TIMEOUT_MS + 60_000;
    const next = run(s, later, { url: 'https://example.com/b' });
    expect(next.session.id).not.toBe(first.session.id);
    expect(next.event.seq).toBe(1);
    expect(next.session.pageviews).toBe(1);
    expect(next.session.engaged_ms).toBe(0);
    expect(next.session.started_at).toBe(later);
    expect(next.session.entry_path).toBe('/b');
    expect(next.session.ref_type).toBe('direct');
  });

  it('keeps sessions separate per visitor and per site', () => {
    const s = new Sessionizer();
    const a = run(s, T0);
    const other = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
    const b = run(s, T0, {}, { visitorId: other });
    const c = run(s, T0, { siteId: 2 }, { site: { ...SITE, id: 2 } });
    expect(b.session.id).not.toBe(a.session.id);
    expect(c.session.id).not.toBe(a.session.id);
    expect(s.size).toBe(3);
  });

  it('clamps a negative clock gap to zero', () => {
    const s = new Sessionizer();
    run(s, T0);
    const { session } = run(s, T0 - 1_000);
    expect(session.engaged_ms).toBe(0);
  });
});

describe('seq and counters across hit types', () => {
  it('assigns 1-based seq to every stored row, pings included', () => {
    const s = new Sessionizer();
    const types = [
      run(s, T0),
      run(s, T0 + 1_000, { type: 'event', event: { category: 'ui', action: 'click' } }),
      run(s, T0 + 2_000, { type: 'ping', url: undefined }),
      run(s, T0 + 3_000, { type: 'outlink', targetUrl: 'https://other.org/x' }),
    ];
    expect(types.map((t) => t.event.seq)).toEqual([1, 2, 3, 4]);
    expect(types.map((t) => t.event.type)).toEqual(['pageview', 'event', 'ping', 'outlink']);
    const last = types[3]?.session;
    expect(last?.pageviews).toBe(1);
    expect(last?.events).toBe(1);
  });

  it('stores pings as event rows but never counts them as pageviews', () => {
    const s = new Sessionizer();
    run(s, T0);
    const ping = run(s, T0 + 10_000, { type: 'ping' });
    expect(ping.event.type).toBe('ping');
    expect(ping.session.pageviews).toBe(1);
    expect(ping.session.engaged_ms).toBe(10_000);
  });

  it('accrues ping engagement per gap and clamps each gap', () => {
    const s = new Sessionizer();
    run(s, T0);
    run(s, T0 + 15_000, { type: 'ping' });
    const second = run(s, T0 + 30_000, { type: 'ping' });
    expect(second.session.engaged_ms).toBe(30_000);
    const afterLongGap = run(s, T0 + 30_000 + 120_000, { type: 'ping' });
    expect(afterLongGap.session.engaged_ms).toBe(30_000 + PING_CLAMP_MS);
  });

  it('updates exit_path only on pageviews', () => {
    const s = new Sessionizer();
    run(s, T0);
    const event = run(s, T0 + 1_000, {
      type: 'event',
      url: 'https://example.com/b',
      event: { category: 'ui', action: 'click' },
    });
    expect(event.session.exit_path).toBe('/a');
    const ping = run(s, T0 + 2_000, { type: 'ping', url: 'https://example.com/c' });
    expect(ping.session.exit_path).toBe('/a');
  });

  it('records event payload and outlink target on the event row', () => {
    const s = new Sessionizer();
    const evt = run(s, T0, {
      type: 'event',
      event: { category: 'video', action: 'play', name: 'intro', value: 2.5 },
    });
    expect(evt.event.event_category).toBe('video');
    expect(evt.event.event_action).toBe('play');
    expect(evt.event.event_name).toBe('intro');
    expect(evt.event.event_value).toBe(2.5);
    const out = run(s, T0 + 1_000, { type: 'outlink', targetUrl: 'https://other.org/x' });
    expect(out.event.target_url).toBe('https://other.org/x');
  });

  it('keeps the query string in path but treats an unparseable url as path text', () => {
    const s = new Sessionizer();
    const { event } = run(s, T0, { url: 'https://example.com/search?q=owls' });
    expect(event.path).toBe('/search?q=owls');
    const bad = run(s, T0 + 1_000, { url: 'not a url' });
    expect(bad.event.hostname).toBeNull();
    expect(bad.event.path).toBe('not a url');
  });
});

describe('engagement-aware bounce ingredients (docs/03)', () => {
  it('a lone pageview leaves bounce-shaped numbers', () => {
    const s = new Sessionizer();
    const { session } = run(s, T0);
    expect(session.pageviews).toBe(1);
    expect(session.events).toBe(0);
    expect(session.engaged_ms).toBeLessThan(ENGAGEMENT_THRESHOLD_MS);
  });

  it('heartbeat pings push a single-page read past the engagement threshold', () => {
    const s = new Sessionizer();
    run(s, T0);
    run(s, T0 + 15_000, { type: 'ping' });
    const { session } = run(s, T0 + 30_000, { type: 'ping' });
    expect(session.pageviews).toBe(1);
    expect(session.events).toBe(0);
    expect(session.engaged_ms).toBeGreaterThanOrEqual(ENGAGEMENT_THRESHOLD_MS);
  });
});

describe('attribution', () => {
  it('campaign params beat the referrer and store under utm_ columns', () => {
    const s = new Sessionizer();
    const { session } = run(s, T0, {
      url: 'https://example.com/landing?utm_source=newsletter&utm_medium=email&utm_campaign=july',
      referrer: 'https://www.google.com/',
    });
    expect(session.ref_type).toBe('campaign');
    expect(session.utm_source).toBe('newsletter');
    expect(session.utm_medium).toBe('email');
    expect(session.utm_campaign).toBe('july');
    expect(session.ref_domain).toBe('google.com');
  });

  it('accepts the mtm_* and pk_* param families', () => {
    const s = new Sessionizer();
    const mtm = run(s, T0, { url: 'https://example.com/?mtm_source=partner&mtm_campaign=spring' });
    expect(mtm.session.ref_type).toBe('campaign');
    expect(mtm.session.utm_source).toBe('partner');
    expect(mtm.session.utm_campaign).toBe('spring');

    const s2 = new Sessionizer();
    const pk = run(s2, T0, { url: 'https://example.com/?pk_campaign=fall' });
    expect(pk.session.ref_type).toBe('campaign');
    expect(pk.session.utm_campaign).toBe('fall');
  });

  it('classifies own-domain referrers as internal, subdomains included', () => {
    const s = new Sessionizer();
    const www = run(s, T0, { referrer: 'https://www.example.com/other' });
    expect(www.session.ref_type).toBe('internal');
    expect(www.session.ref_domain).toBe('example.com');

    const s2 = new Sessionizer();
    const sub = run(s2, T0, { referrer: 'https://blog.example.com/post' });
    expect(sub.session.ref_type).toBe('internal');
  });

  it('classifies search and social hosts, matching subdomains of table entries', () => {
    const cases: Array<[string, string, string]> = [
      ['https://www.google.com/', 'search', 'google.com'],
      ['https://www.google.co.uk/url?q=x', 'search', 'google.co.uk'],
      ['https://duckduckgo.com/', 'search', 'duckduckgo.com'],
      ['https://t.co/xyz', 'social', 't.co'],
      ['https://l.facebook.com/l.php?u=x', 'social', 'l.facebook.com'],
      ['https://news.ycombinator.com/item?id=1', 'social', 'news.ycombinator.com'],
    ];
    for (const [referrer, type, domain] of cases) {
      const { session } = run(new Sessionizer(), T0, { referrer });
      expect(session.ref_type, referrer).toBe(type);
      expect(session.ref_domain, referrer).toBe(domain);
    }
  });

  it('falls back to referral for unknown hosts and direct for none', () => {
    const referral = run(new Sessionizer(), T0, { referrer: 'https://blog.partner.org/post' });
    expect(referral.session.ref_type).toBe('referral');
    expect(referral.session.ref_domain).toBe('blog.partner.org');

    const direct = run(new Sessionizer(), T0, {});
    expect(direct.session.ref_type).toBe('direct');
    expect(direct.session.ref_domain).toBeNull();
  });

  it('is first-touch: later referrers never rewrite it, rows carry it denormalized', () => {
    const s = new Sessionizer();
    const first = run(s, T0);
    expect(first.session.ref_type).toBe('direct');
    const second = run(s, T0 + 5_000, {
      url: 'https://example.com/b',
      referrer: 'https://www.google.com/',
    });
    expect(second.session.ref_type).toBe('direct');
    expect(second.event.ref_type).toBe('direct');
    expect(second.event.utm_source).toBeNull();
  });
});

describe('timezones (docs/03)', () => {
  it('computes local date and hour in the site timezone', () => {
    expect(localParts('America/New_York', Date.UTC(2026, 0, 15, 14, 30))).toEqual({
      date: '2026-01-15',
      hour: 9, // EST, UTC-5
    });
    expect(localParts('America/New_York', Date.UTC(2026, 6, 15, 14, 30))).toEqual({
      date: '2026-07-15',
      hour: 10, // EDT, UTC-4
    });
  });

  it('handles the spring-forward DST boundary (2026-03-08, 02:00 EST skipped)', () => {
    expect(localParts('America/New_York', Date.UTC(2026, 2, 8, 6, 59))).toEqual({
      date: '2026-03-08',
      hour: 1,
    });
    expect(localParts('America/New_York', Date.UTC(2026, 2, 8, 7, 1))).toEqual({
      date: '2026-03-08',
      hour: 3,
    });
  });

  it('handles the fall-back DST boundary (2026-11-01, 01:00 repeats)', () => {
    expect(localParts('America/New_York', Date.UTC(2026, 10, 1, 5, 30)).hour).toBe(1); // EDT
    expect(localParts('America/New_York', Date.UTC(2026, 10, 1, 6, 30)).hour).toBe(1); // EST
    expect(localParts('America/New_York', Date.UTC(2026, 10, 1, 7, 30)).hour).toBe(2);
  });

  it('rolls the local date at local midnight, not UTC midnight', () => {
    expect(localParts('America/New_York', Date.UTC(2026, 6, 28, 3, 30)).date).toBe('2026-07-27');
    expect(localParts('America/New_York', Date.UTC(2026, 6, 28, 4, 30)).date).toBe('2026-07-28');
  });

  it('falls back to UTC for an invalid timezone instead of breaking ingest', () => {
    expect(localParts('Not/A_Zone', Date.UTC(2026, 6, 27, 14))).toEqual({
      date: '2026-07-27',
      hour: 14,
    });
  });

  it("keeps the session's local_date at its start while event rows roll over", () => {
    const s = new Sessionizer();
    const beforeMidnight = Date.UTC(2026, 6, 28, 3, 45); // 23:45 EDT on 07-27
    const first = run(s, beforeMidnight);
    expect(first.session.local_date).toBe('2026-07-27');
    // 25 min later: inside the idle window, but past local midnight.
    const after = run(s, beforeMidnight + 1_500_000, { url: 'https://example.com/b' });
    expect(after.event.local_date).toBe('2026-07-28');
    expect(after.session.local_date).toBe('2026-07-27');
  });
});

describe('restart recovery', () => {
  it('loads sessions inside the idle window with their max seq, skipping stale ones', () => {
    const db = openDb(':memory:');
    const open = { id: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]), last_seen_at: T0 - 60_000 };
    const stale = {
      id: Uint8Array.from([2, 2, 2, 2, 2, 2, 2, 2]),
      last_seen_at: T0 - SESSION_TIMEOUT_MS - 1,
    };
    withWriteTransaction(db, () => {
      for (const s of [open, stale]) {
        upsertSessions(db, [
          {
            id: s.id,
            site_id: 1,
            visitor_id: VISITOR,
            started_at: s.last_seen_at - 10_000,
            last_seen_at: s.last_seen_at,
            local_date: '2026-07-27',
            entry_path: '/a',
            exit_path: '/b',
            pageviews: 2,
            events: 1,
            engaged_ms: 12_000,
            ref_type: 'direct',
          },
        ]);
      }
      insertEvents(db, [
        {
          site_id: 1,
          ts: T0 - 60_000,
          local_date: '2026-07-27',
          local_hour: 9,
          type: 'pageview',
          visitor_id: VISITOR,
          session_id: open.id,
          seq: 3,
        },
      ]);
    });

    const restored = loadOpenSessions(db, T0);
    expect(restored).toHaveLength(1);
    expect(Buffer.from(restored[0]?.row.id ?? [])).toEqual(Buffer.from(open.id));
    expect(restored[0]?.seq).toBe(3);
    expect(restored[0]?.row.pageviews).toBe(2);
    db.close();
  });

  it('continues a restored session: same id, seq keeps counting, counters carry on', () => {
    const db = openDb(':memory:');
    const id = Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 7]);
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        {
          id,
          site_id: 1,
          visitor_id: VISITOR,
          started_at: T0 - 120_000,
          last_seen_at: T0 - 60_000,
          local_date: '2026-07-27',
          entry_path: '/a',
          exit_path: '/a',
          pageviews: 1,
          events: 0,
          engaged_ms: 4_000,
          ref_type: 'search',
          ref_domain: 'google.com',
        },
      ]);
      insertEvents(db, [
        {
          site_id: 1,
          ts: T0 - 60_000,
          local_date: '2026-07-27',
          local_hour: 9,
          type: 'pageview',
          visitor_id: VISITOR,
          session_id: id,
          seq: 1,
        },
      ]);
    });

    const s = new Sessionizer();
    s.restore(loadOpenSessions(db, T0));
    expect(s.size).toBe(1);
    const { event, session } = run(s, T0, { url: 'https://example.com/next' });
    expect(Buffer.from(session.id)).toEqual(Buffer.from(id));
    expect(event.seq).toBe(2);
    expect(session.pageviews).toBe(2);
    expect(session.engaged_ms).toBe(4_000 + PING_CLAMP_MS); // 60 s gap, clamped
    expect(session.ref_type).toBe('search');
    expect(event.ref_type).toBe('search');
    db.close();
  });
});
