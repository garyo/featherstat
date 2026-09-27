import {
  ENGAGEMENT_THRESHOLD_MS,
  type Hit,
  PING_CLAMP_MS,
  READ_MILESTONE,
  SESSION_REVIVAL_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { binId, T0, VISITOR } from '../../test/rows.ts';
import {
  type Db,
  insertEvents,
  openDb,
  type Site,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import type { DeviceInfo } from './enrich.ts';
import type { SessionizerInput } from './sessionizer.ts';
import { loadOpenSessions, priorSessionLookup, Sessionizer } from './sessionizer.ts';

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

function offer(
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

/** A hit that must be stored. Use `offer` where the point is that it might not be. */
function run(...args: Parameters<typeof offer>) {
  const stored = offer(...args);
  if (stored === undefined) throw new Error('the sessionizer dropped a hit it should have stored');
  return stored;
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
    s.noteFlush(); // the batch landed, so the sweep is free to drop the row
    const other = binId(9);
    run(s, T0 + 2 * SESSION_TIMEOUT_MS, {}, { visitorId: other });
    expect(s.size).toBe(1); // the expired session was swept, not retained alongside
  });

  it('holds a swept session until its rows are committed, then lets it go', () => {
    const s = new Sessionizer();
    run(s, T0);
    // The batch has not landed, so the store is not yet the account of this visit
    // and dropping it would strand its seq and counters.
    run(s, T0 + 2 * SESSION_TIMEOUT_MS, {}, { visitorId: binId(9) });
    expect(s.size).toBe(2);
    s.noteFlush();
    run(s, T0 + 4 * SESSION_TIMEOUT_MS, {}, { visitorId: binId(8) });
    expect(s.size).toBe(1);
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

  it('drops tracking params from page identity but keeps the rest of the query', () => {
    const s = new Sessionizer();
    const { event, session } = run(s, T0, {
      url: 'https://example.com/blog/post/?page=2&fbclid=IwAR123&utm_source=news',
    });
    expect(event.path).toBe('/blog/post/?page=2');
    expect(session.entry_path).toBe('/blog/post/?page=2');
    expect(session.exit_path).toBe('/blog/post/?page=2');
    // The raw URL still fed campaign extraction before stripping.
    expect(session.utm_source).toBe('news');
  });

  it('collapses an emptied query to the plain pathname — no trailing "?"', () => {
    const { event } = run(new Sessionizer(), T0, {
      url: 'https://example.com/blog/ai-future-of-mathematics/?fbclid=IwAR0abc',
    });
    expect(event.path).toBe('/blog/ai-future-of-mathematics/');
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

  // The tracker synthesized it; the visitor did nothing. On a page that fits
  // the viewport it used to arrive with the page view, and no visit to such a
  // page could ever bounce.
  it('a read milestone is stored as an event but never counts against bounce', () => {
    const s = new Sessionizer();
    run(s, T0);
    const { event, session } = run(s, T0 + 1_000, { type: 'event', event: READ_MILESTONE });
    expect(event.type).toBe('event');
    expect(event.event_category).toBe('scroll');
    expect(event.event_action).toBe('read');
    expect(session.events).toBe(0);
    expect(session.engaged_ms).toBeLessThan(ENGAGEMENT_THRESHOLD_MS);
  });

  it('the same category with any other action is the visitor, and counts', () => {
    const s = new Sessionizer();
    run(s, T0);
    const { session } = run(s, T0 + 1_000, {
      type: 'event',
      event: { category: 'scroll', action: 'jump-to-top' },
    });
    expect(session.events).toBe(1);
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

  it('synthesizes campaign attribution from a click id when no utm arrived', () => {
    const s = new Sessionizer();
    const { event, session } = run(s, T0, {
      url: 'https://example.com/blog/post/?fbclid=IwAR123',
    });
    expect(event.path).toBe('/blog/post/');
    expect(session.ref_type).toBe('campaign');
    expect(session.utm_source).toBe('facebook');
    expect(session.utm_medium).toBe('social');
    expect(session.utm_campaign).toBeNull(); // never invented
    expect(session.utm_source_raw).toBeNull(); // synthesized: nothing normalized away
    expect(session.utm_medium_raw).toBeNull();
    expect(session.ref_domain).toBeNull(); // fbclid with no referrer is not direct
    expect(event.utm_source).toBe('facebook');
  });

  it('maps each click-id family to its platform', () => {
    const cases: Array<[string, string, string]> = [
      ['gclid=x', 'google', 'cpc'],
      ['gbraid=x', 'google', 'cpc'],
      ['wbraid=x', 'google', 'cpc'],
      ['dclid=x', 'google', 'cpc'],
      ['fbclid=x', 'facebook', 'social'],
      ['msclkid=x', 'bing', 'cpc'],
      ['twclid=x', 'twitter', 'social'],
      ['ttclid=x', 'tiktok', 'social'],
      ['li_fat_id=x', 'linkedin', 'social'],
      ['igshid=x', 'instagram', 'social'],
      ['igsh=x', 'instagram', 'social'],
    ];
    for (const [query, source, medium] of cases) {
      const { session } = run(new Sessionizer(), T0, { url: `https://example.com/?${query}` });
      expect(session.ref_type, query).toBe('campaign');
      expect(session.utm_source, query).toBe(source);
      expect(session.utm_medium, query).toBe(medium);
    }
  });

  it('real utm params always win over a click id', () => {
    const { session } = run(new Sessionizer(), T0, {
      url: 'https://example.com/?utm_source=newsletter&utm_medium=email&gclid=abc',
    });
    expect(session.utm_source).toBe('newsletter');
    expect(session.utm_medium).toBe('email');
  });

  it('a click id beside a real referrer still names the platform, keeping the domain', () => {
    // The click id is the more specific signal: l.facebook.com says "Facebook
    // let this through"; fbclid says "and it was a tracked placement".
    const { session } = run(new Sessionizer(), T0, {
      url: 'https://example.com/landing?fbclid=IwAR9',
      referrer: 'https://l.facebook.com/l.php?u=x',
    });
    expect(session.ref_type).toBe('campaign');
    expect(session.utm_source).toBe('facebook');
    expect(session.utm_medium).toBe('social');
    expect(session.ref_domain).toBe('facebook.com');
    expect(session.ref_domain_raw).toBe('l.facebook.com');
  });

  it('identity-only tracking ids strip from the path but attribute nothing', () => {
    const { event, session } = run(new Sessionizer(), T0, {
      url: 'https://example.com/newsletter?mc_eid=abc123',
    });
    expect(event.path).toBe('/newsletter');
    expect(session.ref_type).toBe('direct');
    expect(session.utm_source).toBeNull();
  });

  it('classifies own-domain referrers as internal, subdomains included', () => {
    const s = new Sessionizer();
    const www = run(s, T0, { referrer: 'https://www.example.com/other' });
    expect(www.session.ref_type).toBe('internal');
    expect(www.session.ref_domain).toBe('example.com');
    expect(www.session.ref_domain_raw).toBe('www.example.com');

    const s2 = new Sessionizer();
    const sub = run(s2, T0, { referrer: 'https://blog.example.com/post' });
    expect(sub.session.ref_type).toBe('internal');
  });

  it('classifies search and social hosts, matching subdomains of table entries', () => {
    // ref_domain is the canonical domain (referrers.ts); the classification
    // still has to survive the collapse, and news.google.com still has to stay
    // its own row while reading as search.
    const cases: Array<[string, string, string]> = [
      ['https://www.google.com/', 'search', 'google.com'],
      ['https://www.google.co.uk/url?q=x', 'search', 'google.co.uk'],
      ['https://news.google.com/read/x', 'search', 'news.google.com'],
      ['https://duckduckgo.com/', 'search', 'duckduckgo.com'],
      ['https://t.co/xyz', 'social', 'twitter.com'],
      ['https://l.facebook.com/l.php?u=x', 'social', 'facebook.com'],
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
    expect(referral.session.ref_domain).toBe('partner.org');
    expect(referral.session.ref_domain_raw).toBe('blog.partner.org');

    const direct = run(new Sessionizer(), T0, {});
    expect(direct.session.ref_type).toBe('direct');
    expect(direct.session.ref_domain).toBeNull();
    expect(direct.session.ref_domain_raw).toBeNull();
  });

  it('keeps the received host only when canonicalization changed it', () => {
    const collapsed = run(new Sessionizer(), T0, { referrer: 'https://go.bsky.app/abc' });
    expect(collapsed.session.ref_domain).toBe('bsky.app');
    expect(collapsed.session.ref_domain_raw).toBe('go.bsky.app');
    // Denormalized onto the event row too, so a raw query never has to join.
    expect(collapsed.event.ref_domain_raw).toBe('go.bsky.app');

    const already = run(new Sessionizer(), T0, { referrer: 'https://bsky.app/profile/x' });
    expect(already.session.ref_domain).toBe('bsky.app');
    expect(already.session.ref_domain_raw).toBeNull();
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
            local_hour: 10,
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
          local_hour: 10,
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

describe('session revival (docs/03)', () => {
  const PRIOR = binId(7);

  /** A flushed session for VISITOR, exactly as the batcher would have left it. */
  function seed(db: Db, lastSeenAt: number): void {
    withWriteTransaction(db, () => {
      upsertSessions(db, [
        {
          id: PRIOR,
          site_id: 1,
          visitor_id: VISITOR,
          started_at: lastSeenAt - 180_000,
          last_seen_at: lastSeenAt,
          local_date: '2026-07-27',
          local_hour: 10,
          entry_path: '/a',
          exit_path: '/a',
          pageviews: 1,
          events: 0,
          engaged_ms: 180_000,
          ref_type: 'search',
          ref_domain: 'google.com',
        },
      ]);
      insertEvents(db, [
        {
          site_id: 1,
          ts: lastSeenAt,
          local_date: '2026-07-27',
          local_hour: 10,
          type: 'ping',
          visitor_id: VISITOR,
          session_id: PRIOR,
          seq: 13,
        },
      ]);
    });
  }

  function withSeededDb(lastSeenAt: number, body: (s: Sessionizer) => void): void {
    const db = openDb(':memory:');
    seed(db, lastSeenAt);
    try {
      body(new Sessionizer(priorSessionLookup(db)));
    } finally {
      db.close();
    }
  }

  it('drops a ping with nothing to continue instead of opening a pageview-less visit', () => {
    const s = new Sessionizer();
    expect(offer(s, T0, { type: 'ping' })).toBeUndefined();
    expect(s.size).toBe(0);
    expect(s.droppedPings).toBe(1);
  });

  it("revives the visitor's last session rather than starting one, and continues its seq", () => {
    const away = T0 + SESSION_TIMEOUT_MS + 5 * 60_000; // 35 min of silence
    withSeededDb(T0, (s) => {
      const { event, session } = run(s, away, { type: 'ping' });
      expect(Buffer.from(session.id)).toEqual(Buffer.from(PRIOR));
      expect(event.seq).toBe(14);
      expect(session.pageviews).toBe(1); // a ping is not a pageview, revived or not
      expect(session.started_at).toBe(T0 - 180_000); // still the visit's own start
      expect(session.local_date).toBe('2026-07-27');
      expect(session.ref_type).toBe('search'); // first-touch attribution survives
      expect(s.droppedPings).toBe(0);
    });
  });

  it('credits the silence one clamped heartbeat, never the whole gap', () => {
    const away = T0 + 30 * 60_000;
    withSeededDb(T0, (s) => {
      expect(run(s, away, { type: 'ping' }).session.engaged_ms).toBe(180_000 + PING_CLAMP_MS);
    });
  });

  it('reaches back exactly SESSION_REVIVAL_MS and no further', () => {
    withSeededDb(T0, (s) => {
      expect(offer(s, T0 + SESSION_REVIVAL_MS, { type: 'ping' })).toBeDefined();
    });
    withSeededDb(T0, (s) => {
      expect(offer(s, T0 + SESSION_REVIVAL_MS + 1, { type: 'ping' })).toBeUndefined();
      expect(s.droppedPings).toBe(1);
      expect(s.size).toBe(0);
    });
  });

  it('revives once, then continues live: no second lookup starts a second visit', () => {
    const away = T0 + 35 * 60_000;
    withSeededDb(T0, (s) => {
      const first = run(s, away, { type: 'ping' });
      const second = run(s, away + 15_000, { type: 'ping' });
      expect(Buffer.from(second.session.id)).toEqual(Buffer.from(first.session.id));
      expect(second.event.seq).toBe(15);
      expect(second.session.engaged_ms).toBe(180_000 + PING_CLAMP_MS + 15_000);
      expect(s.size).toBe(1);
    });
  });

  it('never revives for a page view — arriving past the timeout is a new visit', () => {
    const away = T0 + 35 * 60_000;
    withSeededDb(T0, (s) => {
      const { event, session } = run(s, away);
      expect(Buffer.from(session.id)).not.toEqual(Buffer.from(PRIOR));
      expect(event.seq).toBe(1);
      expect(session.ref_type).toBe('direct'); // attribution re-evaluated
    });
  });

  // The ghost visit from the other side: a reader comes back to an open tab
  // after half an hour and clicks something. That is the page they had open,
  // not a visit with no page in it.
  it('revives for an action taken on a page already open', () => {
    const away = T0 + 35 * 60_000;
    for (const type of ['event', 'outlink', 'download'] as const) {
      withSeededDb(T0, (s) => {
        const { event, session } = run(s, away, {
          type,
          event: { category: 'ui', action: 'click' },
          targetUrl: 'https://other.org/x',
        });
        expect(Buffer.from(session.id), type).toEqual(Buffer.from(PRIOR));
        expect(event.seq, type).toBe(14);
        expect(session.pageviews, type).toBe(1);
        expect(session.ref_type, type).toBe('search'); // first-touch survives
        expect(session.engaged_ms, type).toBe(180_000 + PING_CLAMP_MS);
        expect(session.events, type).toBe(type === 'event' ? 1 : 0);
      });
    }
  });

  // A server-side sender — the signup webhook — has no page to belong to, and
  // its action is real: dropping it would lose the conversion.
  it('still opens a visit for an action with nothing to revive', () => {
    const s = new Sessionizer();
    const { event, session } = run(s, T0, {
      type: 'event',
      url: undefined,
      event: { category: 'signup', action: 'account-created' },
    });
    expect(event.seq).toBe(1);
    expect(session.pageviews).toBe(0);
    expect(session.events).toBe(1);
    expect(s.droppedPings).toBe(0);
  });

  it('drops a tracker milestone with nothing to continue, like a heartbeat', () => {
    const s = new Sessionizer();
    expect(offer(s, T0, { type: 'event', event: READ_MILESTONE })).toBeUndefined();
    expect(s.size).toBe(0);
    expect(s.droppedPings).toBe(1);
    withSeededDb(T0, (revived) => {
      const stored = run(revived, T0 + 35 * 60_000, { type: 'event', event: READ_MILESTONE });
      expect(Buffer.from(stored.session.id)).toEqual(Buffer.from(PRIOR));
    });
  });

  it('never revives another site or another visitor', () => {
    const away = T0 + 35 * 60_000;
    withSeededDb(T0, (s) => {
      expect(
        offer(s, away, { siteId: 2, type: 'ping' }, { site: { ...SITE, id: 2 } }),
      ).toBeUndefined();
      expect(offer(s, away, { type: 'ping' }, { visitorId: binId(9) })).toBeUndefined();
      expect(s.droppedPings).toBe(2);
    });
  });
});
