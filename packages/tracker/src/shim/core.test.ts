import { describe, expect, it } from 'vitest';
import { type Effect, INITIAL_STATE, type PageInfo, ping, reduce, type ShimState } from './core.ts';

const PAGE: PageInfo = {
  url: 'https://blog.oberbrunner.com/posts/hello?utm_source=hn',
  title: 'Hello World',
  referrer: 'https://news.ycombinator.com/',
  screen: '1512x982',
  lang: 'en-us',
};

const TRACKER_URL = 'https://analytics.example.org/matomo.php';

/** Fold a queue the way the shim does, keeping every effect in order. */
function run(commands: unknown[], page: PageInfo = PAGE, state: ShimState = INITIAL_STATE) {
  const effects: Effect[] = [];
  for (const command of commands) {
    const reduction = reduce(state, command, page);
    state = reduction.state;
    effects.push(...reduction.effects);
  }
  return { state, effects };
}

/** The production snippet configures *after* tracking (docs/01). */
function configured(commands: unknown[], page: PageInfo = PAGE) {
  return run([['setTrackerUrl', TRACKER_URL], ['setSiteId', '2'], ...commands], page);
}

function beacons(effects: readonly Effect[]): URLSearchParams[] {
  return effects
    .filter((effect) => effect.kind === 'beacon')
    .map((effect) => new URLSearchParams(effect.beacon.body));
}

function only(effects: readonly Effect[]): URLSearchParams {
  const parsed = beacons(effects);
  expect(parsed).toHaveLength(1);
  return parsed[0] as URLSearchParams;
}

describe('tracking commands', () => {
  it('builds a pageview the golden corpus would recognize', () => {
    const { effects } = configured([['trackPageView']]);
    const params = only(effects);
    expect(Object.fromEntries(params)).toEqual({
      idsite: '2',
      rec: '1',
      url: PAGE.url,
      action_name: 'Hello World',
      urlref: PAGE.referrer,
      res: '1512x982',
      lang: 'en-us',
      send_image: '0',
    });
  });

  it('sends every hit to the configured tracker URL', () => {
    const { effects } = configured([['trackPageView']]);
    expect(effects[0]).toMatchObject({ kind: 'beacon', beacon: { url: TRACKER_URL } });
  });

  it('takes the title from the command, then setDocumentTitle, then the document', () => {
    expect(only(configured([['trackPageView', 'Explicit']]).effects).get('action_name')).toBe(
      'Explicit',
    );
    const stateful = configured([['setDocumentTitle', 'Configured'], ['trackPageView']]);
    expect(only(stateful.effects).get('action_name')).toBe('Configured');
  });

  it('honors setCustomUrl and setReferrerUrl for every later hit', () => {
    const { effects } = configured([
      ['setCustomUrl', 'https://blog.oberbrunner.com/spa/route'],
      ['setReferrerUrl', 'https://example.net/from'],
      ['trackPageView'],
      ['trackEvent', 'share', 'copy-link'],
    ]);
    const [pageview, event] = beacons(effects);
    expect(pageview?.get('url')).toBe('https://blog.oberbrunner.com/spa/route');
    expect(pageview?.get('urlref')).toBe('https://example.net/from');
    expect(event?.get('url')).toBe('https://blog.oberbrunner.com/spa/route');
  });

  it('omits a missing title and referrer rather than sending empties', () => {
    const bare: PageInfo = { url: 'https://pcons.org/', title: '', referrer: '' };
    const params = only(configured([['trackPageView']], bare).effects);
    expect(params.has('action_name')).toBe(false);
    expect(params.has('urlref')).toBe(false);
    expect(params.has('res')).toBe(false);
    expect(params.has('lang')).toBe(false);
  });

  it('maps trackEvent to e_c/e_a/e_n/e_v', () => {
    const params = only(
      configured([['trackEvent', 'share', 'copy-link', 'Cambrian Explosion', 2.5]]).effects,
    );
    expect(Object.fromEntries(params)).toMatchObject({
      e_c: 'share',
      e_a: 'copy-link',
      e_n: 'Cambrian Explosion',
      e_v: '2.5',
      url: PAGE.url,
    });
  });

  it('drops half-declared events and non-numeric values', () => {
    expect(beacons(configured([['trackEvent', 'share']]).effects)).toHaveLength(0);
    expect(beacons(configured([['trackEvent']]).effects)).toHaveLength(0);
    const params = only(configured([['trackEvent', 'share', 'copy', 'name', 'lots']]).effects);
    expect(params.has('e_v')).toBe(false);
  });

  it('maps trackLink to link or download, keeping the source page', () => {
    const outlink = only(
      configured([['trackLink', 'https://github.com/garyo/pcons', 'link']]).effects,
    );
    expect(outlink.get('link')).toBe('https://github.com/garyo/pcons');
    expect(outlink.get('url')).toBe(PAGE.url);
    const download = only(
      configured([['trackLink', 'https://pcons.org/dist/pcons-2.1.tar.gz', 'download']]).effects,
    );
    expect(download.get('download')).toBe('https://pcons.org/dist/pcons-2.1.tar.gz');
    expect(beacons(configured([['trackLink']]).effects)).toHaveLength(0);
  });

  it('pings with the page only — the server clock is authoritative', () => {
    const { state } = configured([]);
    const params = only(ping(state, PAGE).effects);
    expect(Object.fromEntries(params)).toEqual({
      idsite: '2',
      rec: '1',
      ping: '1',
      url: PAGE.url,
      send_image: '0',
    });
  });
});

describe('configuration commands', () => {
  it('accepts a numeric site id and ignores empty configuration', () => {
    const { effects } = run([
      ['setTrackerUrl', TRACKER_URL],
      ['setSiteId', 4],
      ['setCustomUrl', ''],
      ['trackPageView'],
    ]);
    const params = only(effects);
    expect(params.get('idsite')).toBe('4');
    expect(params.get('url')).toBe(PAGE.url);
  });

  it('turns enableHeartBeatTimer into a heartbeat effect, defaulting to 15 s', () => {
    expect(run([['enableHeartBeatTimer', 15]]).effects).toEqual([
      { kind: 'heartbeat', seconds: 15 },
    ]);
    expect(run([['enableHeartBeatTimer']]).effects).toEqual([{ kind: 'heartbeat', seconds: 15 }]);
    expect(run([['enableHeartBeatTimer', 'soon']]).effects).toEqual([
      { kind: 'heartbeat', seconds: 15 },
    ]);
  });

  it('turns enableLinkTracking into a link-tracking effect', () => {
    expect(run([['enableLinkTracking']]).effects).toEqual([{ kind: 'link-tracking' }]);
  });

  it('treats disableCookies as a no-op — the tracker is always cookieless', () => {
    expect(run([['disableCookies']]).effects).toEqual([]);
  });
});

describe('unknown and malformed commands', () => {
  it('debugs each unsupported command exactly once', () => {
    const { effects } = run([
      ['setUserId', 'u1'],
      ['setUserId', 'u2'],
      ['trackGoal', 3],
    ]);
    expect(effects).toEqual([
      { kind: 'debug', message: 'ignoring unsupported _paq command: setUserId' },
      { kind: 'debug', message: 'ignoring unsupported _paq command: trackGoal' },
    ]);
  });

  it('ignores entries that are not [name, ...args]', () => {
    const { effects } = run([[], [42], 'trackPageView', null, undefined, { push: 1 }]);
    expect(effects).toEqual([]);
  });
});

describe('pre-load queue draining', () => {
  it('flushes hits queued before setTrackerUrl/setSiteId, in order', () => {
    // The real snippet's order: track first, configure last.
    const { effects } = run([
      ['disableCookies'],
      ['enableHeartBeatTimer', 15],
      ['trackPageView'],
      ['trackEvent', 'app', 'ready'],
      ['enableLinkTracking'],
      ['setTrackerUrl', TRACKER_URL],
      ['setSiteId', '2'],
    ]);
    expect(effects.map((effect) => effect.kind)).toEqual([
      'heartbeat',
      'link-tracking',
      'beacon',
      'beacon',
    ]);
    const [pageview, event] = beacons(effects);
    expect(pageview?.get('action_name')).toBe('Hello World');
    expect(event?.get('e_a')).toBe('ready');
  });

  it('holds hits until both the tracker URL and the site id are known', () => {
    const partial = run([['trackPageView'], ['setSiteId', '2']]);
    expect(partial.effects).toEqual([]);
    expect(partial.state.pending).toHaveLength(1);
    const { effects } = run([['setTrackerUrl', TRACKER_URL]], PAGE, partial.state);
    expect(beacons(effects)).toHaveLength(1);
  });

  it('remembers the page each queued hit was pushed from', () => {
    const first = run([['trackPageView']]);
    const second = run(
      [['trackPageView']],
      { ...PAGE, url: 'https://blog.example/second' },
      first.state,
    );
    const { effects } = run(
      [
        ['setTrackerUrl', TRACKER_URL],
        ['setSiteId', '2'],
      ],
      PAGE,
      second.state,
    );
    expect(beacons(effects).map((params) => params.get('url'))).toEqual([
      PAGE.url,
      'https://blog.example/second',
    ]);
  });

  it('stops queueing for a tag that never configures itself', () => {
    const commands = Array.from({ length: 25 }, () => ['trackPageView']);
    const { state } = run(commands);
    expect(state.pending).toHaveLength(20);
  });
});
