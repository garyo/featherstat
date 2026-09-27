import { localClock } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  actionUrl,
  type MatomoActionRow,
  type MatomoVisitRow,
  mapAction,
  mapSite,
  mapVisit,
  matomoTimezone,
  sessionIdForVisit,
} from './mappers.ts';

/** Hand-authored Matomo 5 row shapes — the fixture contract for the importer. */

const NY = 'America/New_York';
const IDVISITOR = Buffer.from('0123456789abcdef', 'hex');

function visitRow(overrides: Partial<MatomoVisitRow> = {}): MatomoVisitRow {
  return {
    idvisit: 42,
    idsite: 1,
    idvisitor: IDVISITOR,
    visit_first_action_time: '2026-01-02 03:30:00',
    visit_last_action_time: '2026-01-02 03:35:00',
    visit_total_time: 300,
    visit_total_actions: 4,
    visit_total_events: 1,
    referer_type: 2,
    referer_name: 'Google',
    referer_url: 'https://www.google.com/',
    campaign_name: null,
    campaign_source: null,
    campaign_medium: null,
    config_browser_name: 'CH',
    config_browser_version: '126.0',
    config_os: 'WIN',
    config_device_type: 0,
    config_resolution: '1920x1080',
    location_browser_lang: 'en-us',
    location_country: 'us',
    location_region: 'MA',
    location_city: 'Boston',
    location_latitude: '42.360100',
    location_longitude: '-71.058900',
    entry_url_name: 'example.com/landing?a=1',
    entry_url_prefix: 3,
    exit_url_name: 'example.com/bye',
    exit_url_prefix: 2,
    ...overrides,
  };
}

function actionRow(overrides: Partial<MatomoActionRow> = {}): MatomoActionRow {
  const visit = visitRow();
  return {
    idlink_va: 900,
    idvisit: visit.idvisit,
    idsite: visit.idsite,
    idvisitor: IDVISITOR,
    server_time: '2026-01-02 03:30:05',
    custom_float: null,
    url_type: 1,
    url_name: 'example.com/landing?a=1',
    url_prefix: 2,
    name_type: 4,
    name_name: 'Landing page',
    event_category: null,
    event_action: null,
    referer_type: visit.referer_type,
    referer_name: visit.referer_name,
    referer_url: visit.referer_url,
    campaign_name: visit.campaign_name,
    campaign_source: visit.campaign_source,
    campaign_medium: visit.campaign_medium,
    config_browser_name: visit.config_browser_name,
    config_browser_version: visit.config_browser_version,
    config_os: visit.config_os,
    config_device_type: visit.config_device_type,
    config_resolution: visit.config_resolution,
    location_browser_lang: visit.location_browser_lang,
    location_country: visit.location_country,
    location_region: visit.location_region,
    location_city: visit.location_city,
    location_latitude: visit.location_latitude,
    location_longitude: visit.location_longitude,
    ...overrides,
  };
}

describe('mapSite', () => {
  it('preserves the Matomo id and merges main + alias URLs into hostnames', () => {
    const site = mapSite(
      {
        idsite: 3,
        name: 'Oberbrunner',
        main_url: 'https://www.example.com',
        ts_created: '2013-04-01 12:00:00',
        timezone: 'America/New_York',
      },
      ['https://example.com/extra/path', 'https://alias.example.org', 'not a url'],
    );
    expect(site).toEqual({
      id: 3,
      name: 'Oberbrunner',
      domains: ['www.example.com', 'example.com', 'alias.example.org'],
      timezone: 'America/New_York',
      created_at: Date.UTC(2013, 3, 1, 12),
    });
  });

  it('omits created_at when ts_created is unparseable', () => {
    const site = mapSite({
      idsite: 1,
      name: 's',
      main_url: 'https://a.test',
      ts_created: '0000-00-00 00:00:00',
      timezone: 'UTC',
    });
    expect(site.created_at).toBeUndefined();
  });

  it('maps a manual UTC offset to a zone the runtime resolves', () => {
    const site = mapSite({
      idsite: 1,
      name: 's',
      main_url: 'https://a.test',
      ts_created: '2013-04-01 12:00:00',
      timezone: 'UTC+5.75',
    });
    expect(site.timezone).toBe('+0545');
  });

  it('refuses a timezone that maps to nothing, naming the site', () => {
    const row = {
      idsite: 7,
      name: 's',
      main_url: 'https://a.test',
      ts_created: '2013-04-01 12:00:00',
      timezone: 'Mars/Olympus_Mons',
    };
    expect(() => mapSite(row)).toThrow(/Matomo site 7 has timezone 'Mars\/Olympus_Mons'/);
  });
});

describe('matomoTimezone', () => {
  it('passes an IANA name through', () => {
    expect(matomoTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(matomoTimezone('UTC')).toBe('UTC');
  });

  it('maps whole-hour manual offsets to Etc/GMT, with the POSIX sign flip', () => {
    expect(matomoTimezone('UTC+10')).toBe('Etc/GMT-10');
    expect(matomoTimezone('UTC-3')).toBe('Etc/GMT+3');
    expect(matomoTimezone('UTC+14')).toBe('Etc/GMT-14');
    expect(matomoTimezone('UTC-12')).toBe('Etc/GMT+12');
    expect(matomoTimezone('UTC+0')).toBe('UTC');
  });

  it('maps fractional offsets to a fixed ±hhmm zone', () => {
    expect(matomoTimezone('UTC-3.5')).toBe('-0330');
    expect(matomoTimezone('UTC+5.75')).toBe('+0545');
    expect(matomoTimezone('UTC+12.75')).toBe('+1245');
    expect(matomoTimezone('UTC-9.5')).toBe('-0930');
  });

  it('computes local clocks on the mapped zone exactly as the offset says', () => {
    const at = Date.UTC(2026, 0, 1, 0, 0);
    for (const [manual, hour, date] of [
      ['UTC+10', 10, '2026-01-01'],
      ['UTC-3.5', 20, '2025-12-31'],
      ['UTC+5.75', 5, '2026-01-01'],
    ] as const) {
      const zone = matomoTimezone(manual);
      if (zone === null) throw new Error(`${manual} did not map`);
      expect(localClock(zone, at), manual).toEqual({ date, hour });
    }
  });

  it('refuses what neither resolves', () => {
    for (const tz of ['Mars/Olympus_Mons', 'UTC+15', 'UTC-13', 'UTC+abc', 'GMT+1']) {
      expect(matomoTimezone(tz), tz).toBeNull();
    }
  });
});

describe('mapVisit', () => {
  it('maps a full Matomo 5 visit to a sessions row', () => {
    const session = mapVisit(visitRow(), NY);
    expect(session).not.toBeNull();
    expect(Buffer.from(session?.id ?? [])).toEqual(Buffer.from(sessionIdForVisit(42)));
    expect(session?.visitor_id).toBe(IDVISITOR);
    expect(session?.started_at).toBe(Date.UTC(2026, 0, 2, 3, 30));
    expect(session?.last_seen_at).toBe(Date.UTC(2026, 0, 2, 3, 35));
    // 03:30 UTC is the previous evening in New York — recomputed per site tz (docs/06).
    expect(session?.local_date).toBe('2026-01-01');
    expect(session?.engaged_ms).toBe(300_000);
    expect(session?.pageviews).toBe(4);
    expect(session?.events).toBe(1);
    expect(session?.entry_path).toBe('/landing?a=1');
    expect(session?.exit_path).toBe('/bye');
    expect(session?.ref_type).toBe('search');
    expect(session?.ref_domain).toBe('google.com');
    expect(session?.browser).toBe('Chrome');
    expect(session?.os).toBe('Windows');
    expect(session?.device_type).toBe('desktop');
    expect(session?.country).toBe('US');
    expect(session?.region).toBe('MA');
    expect(session?.city).toBe('Boston');
  });

  it('survives a NULL-heavy row (fresh direct visit, no geo, no device)', () => {
    const binary = Buffer.from([0, 255, 16, 32, 64, 128, 1, 2]);
    const session = mapVisit(
      visitRow({
        idvisitor: binary,
        visit_total_time: null,
        visit_total_actions: null,
        visit_total_events: null,
        referer_type: 1,
        referer_name: null,
        referer_url: null,
        config_browser_name: null,
        config_browser_version: null,
        config_os: null,
        config_device_type: null,
        config_resolution: null,
        location_browser_lang: null,
        location_country: null,
        location_region: null,
        location_city: null,
        location_latitude: null,
        location_longitude: null,
        entry_url_name: null,
        entry_url_prefix: null,
        exit_url_name: null,
        exit_url_prefix: null,
      }),
      NY,
    );
    expect(session?.visitor_id).toBe(binary);
    expect(session?.engaged_ms).toBe(0);
    expect(session?.pageviews).toBe(0);
    expect(session?.events).toBe(0);
    expect(session?.entry_path).toBeNull();
    expect(session?.exit_path).toBeNull();
    expect(session?.ref_type).toBe('direct');
    expect(session?.ref_domain).toBeNull();
    expect(session?.browser).toBeNull();
    expect(session?.os).toBeNull();
    expect(session?.device_type).toBeNull();
    expect(session?.country).toBeNull();
  });

  it('maps campaign visits to the utm_* columns, falling back to referer_name', () => {
    const explicit = mapVisit(
      visitRow({
        referer_type: 6,
        referer_name: 'july-launch',
        campaign_name: 'july',
        campaign_source: 'newsletter',
        campaign_medium: 'email',
      }),
      NY,
    );
    expect(explicit?.ref_type).toBe('campaign');
    expect(explicit?.utm_campaign).toBe('july');
    expect(explicit?.utm_source).toBe('newsletter');
    expect(explicit?.utm_medium).toBe('email');

    const fallback = mapVisit(visitRow({ referer_type: 6, referer_name: 'legacy-camp' }), NY);
    expect(fallback?.utm_campaign).toBe('legacy-camp');
  });

  it('uses referer_name as the domain for website referrers without a URL', () => {
    const session = mapVisit(
      visitRow({ referer_type: 3, referer_name: 'www.Blog.example.org', referer_url: null }),
      NY,
    );
    expect(session?.ref_type).toBe('referral');
    // Canonicalized exactly as ingest would (docs/03 § Attribution).
    expect(session?.ref_domain).toBe('example.org');
    expect(session?.ref_domain_raw).toBe('www.blog.example.org');
  });

  it('classifies social referrers and passes unknown codes through verbatim', () => {
    const session = mapVisit(
      visitRow({
        referer_type: 7,
        referer_url: 'https://l.facebook.com/l.php?u=x',
        config_browser_name: 'ZZ',
        config_os: 'QQ',
        config_device_type: 5,
      }),
      NY,
    );
    expect(session?.ref_type).toBe('social');
    expect(session?.ref_domain).toBe('facebook.com');
    expect(session?.ref_domain_raw).toBe('l.facebook.com');
    expect(session?.browser).toBe('ZZ');
    expect(session?.os).toBe('QQ');
    expect(session?.device_type).toBe('other');
  });

  it('rejects rows with an unparseable time or malformed idvisitor', () => {
    expect(mapVisit(visitRow({ visit_first_action_time: 'garbage' }), NY)).toBeNull();
    expect(mapVisit(visitRow({ idvisitor: Buffer.from([1, 2, 3]) }), NY)).toBeNull();
  });
});

describe('actionUrl', () => {
  it('reconstructs each url_prefix variant', () => {
    expect(actionUrl('example.com/x', 0)).toBe('http://example.com/x');
    expect(actionUrl('example.com/x', 1)).toBe('http://www.example.com/x');
    expect(actionUrl('example.com/x', 2)).toBe('https://example.com/x');
    expect(actionUrl('example.com/x', 3)).toBe('https://www.example.com/x');
    expect(actionUrl('example.com/x', null)).toBe('http://example.com/x');
  });

  it('keeps names that already carry a scheme (outlinks, downloads)', () => {
    expect(actionUrl('https://other.org/f.pdf', 0)).toBe('https://other.org/f.pdf');
  });
});

describe('mapAction', () => {
  it('maps a pageview with the visit context denormalized onto the row', () => {
    const event = mapAction(actionRow(), NY);
    expect(event?.type).toBe('pageview');
    expect(event?.ts).toBe(Date.UTC(2026, 0, 2, 3, 30, 5));
    expect(event?.local_date).toBe('2026-01-01');
    expect(event?.local_hour).toBe(22);
    expect(event?.hostname).toBe('example.com');
    expect(event?.path).toBe('/landing?a=1');
    expect(event?.title).toBe('Landing page');
    expect(Buffer.from(event?.session_id ?? [])).toEqual(Buffer.from(sessionIdForVisit(42)));
    expect(event?.visitor_id).toBe(IDVISITOR);
    expect(event?.ref_type).toBe('search');
    expect(event?.ref_domain).toBe('google.com');
    expect(event?.browser).toBe('Chrome');
    expect(event?.browser_version).toBe('126.0');
    expect(event?.screen).toBe('1920x1080');
    expect(event?.lang).toBe('en-us');
    expect(event?.country).toBe('US');
    expect(event?.lat).toBeCloseTo(42.3601);
    expect(event?.lon).toBeCloseTo(-71.0589);
  });

  it('honors the url_prefix when rebuilding the page URL', () => {
    const event = mapAction(actionRow({ url_prefix: 1 }), NY);
    expect(event?.hostname).toBe('www.example.com');
  });

  it('maps a Matomo event with category/action/name/value', () => {
    const event = mapAction(
      actionRow({
        event_category: 'Video',
        event_action: 'play',
        name_type: 12,
        name_name: 'intro.mp4',
        custom_float: '1.5',
      }),
      NY,
    );
    expect(event?.type).toBe('event');
    expect(event?.event_category).toBe('Video');
    expect(event?.event_action).toBe('play');
    expect(event?.event_name).toBe('intro.mp4');
    expect(event?.event_value).toBe(1.5);
    expect(event?.hostname).toBe('example.com'); // the page the event fired on
    expect(event?.title).toBeNull();
  });

  it('maps outlinks and downloads to target_url', () => {
    const outlink = mapAction(
      actionRow({
        url_type: 2,
        url_name: 'https://other.org/page',
        name_type: null,
        name_name: null,
      }),
      NY,
    );
    expect(outlink?.type).toBe('outlink');
    expect(outlink?.target_url).toBe('https://other.org/page');
    expect(outlink?.hostname).toBeNull();

    const download = mapAction(
      actionRow({ url_type: 3, url_name: 'example.com/f.pdf', url_prefix: 2 }),
      NY,
    );
    expect(download?.type).toBe('download');
    expect(download?.target_url).toBe('https://example.com/f.pdf');
  });

  it('records a title-only action as a pageview (Matomo title-only actions)', () => {
    const event = mapAction(actionRow({ url_type: null, url_name: null, url_prefix: null }), NY);
    expect(event?.type).toBe('pageview');
    expect(event?.title).toBe('Landing page');
    expect(event?.hostname).toBeNull();
    expect(event?.path).toBeNull();
  });

  it('skips rows outside our model (site search, content) and broken times', () => {
    const search = mapAction(
      actionRow({ url_type: 8, url_name: 'search terms', name_type: null, name_name: null }),
      NY,
    );
    expect(search).toBeNull();
    expect(mapAction(actionRow({ server_time: 'garbage' }), NY)).toBeNull();
  });
});
