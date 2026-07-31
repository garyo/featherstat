import { MAX_COLLECT_HITS } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { parseCollectRequest } from './native.ts';

const body = (payload: unknown): string => JSON.stringify(payload);
const one = (hit: unknown, site = 4): ReturnType<typeof parseCollectRequest> =>
  parseCollectRequest(body({ site, hits: [hit] }));

describe('page views', () => {
  it('normalizes the tracker payload onto the site from the envelope', () => {
    expect(
      one({
        type: 'pageview',
        url: 'https://deep-timeline.org/era/cambrian',
        title: 'Cambrian',
        referrer: 'https://example.com/',
        screen: '2560x1440',
        lang: 'en-US',
      }),
    ).toEqual([
      {
        siteId: 4,
        type: 'pageview',
        url: 'https://deep-timeline.org/era/cambrian',
        title: 'Cambrian',
        referrer: 'https://example.com/',
        screen: '2560x1440',
        lang: 'en-US',
      },
    ]);
  });

  it('strips the fragment, which is never part of page identity', () => {
    expect(one({ type: 'pageview', url: 'https://a.test/post#section-2' })[0]?.url).toBe(
      'https://a.test/post',
    );
  });

  it('takes a ping with nothing but a url', () => {
    expect(one({ type: 'ping', url: 'https://a.test/' })).toEqual([
      { siteId: 4, type: 'ping', url: 'https://a.test/' },
    ]);
  });
});

describe('events, outlinks and downloads', () => {
  it('lifts the flat event fields into the nested event payload', () => {
    expect(one({ type: 'event', category: 'share', action: 'copy-link', value: 3 })).toEqual([
      { siteId: 4, type: 'event', event: { category: 'share', action: 'copy-link', value: 3 } },
    ]);
  });

  it('keeps the destination of an outlink and a download', () => {
    const hits = parseCollectRequest(
      body({
        site: 2,
        hits: [
          { type: 'outlink', url: 'https://a.test/', targetUrl: 'https://elsewhere.test/' },
          { type: 'download', url: 'https://a.test/', targetUrl: 'https://a.test/paper.pdf' },
        ],
      }),
    );
    expect(hits.map((hit) => hit.targetUrl)).toEqual([
      'https://elsewhere.test/',
      'https://a.test/paper.pdf',
    ]);
  });

  // A type that promises a payload it did not bring is an absence of news, not
  // a degraded page view — recording it would invent a hit nobody reported.
  it('drops a hit whose type promised a payload it did not bring', () => {
    expect(one({ type: 'event', category: 'share' })).toEqual([]);
    expect(one({ type: 'event' })).toEqual([]);
    expect(one({ type: 'outlink', url: 'https://a.test/' })).toEqual([]);
    expect(one({ type: 'download', url: 'https://a.test/' })).toEqual([]);
  });
});

describe('never rejects, only records less (invariant 4)', () => {
  it('yields nothing for a body that is missing, empty or not JSON', () => {
    for (const input of [undefined, '', '   ', 'not json', '<html>', 'null', '[]']) {
      expect(parseCollectRequest(input), String(input)).toEqual([]);
    }
  });

  it('yields nothing for an envelope with no usable site', () => {
    for (const site of [0, -1, 1.5, '4', undefined]) {
      expect(parseCollectRequest(body({ site, hits: [{ type: 'ping' }] })), String(site)).toEqual(
        [],
      );
    }
  });

  it('drops one malformed hit and keeps the rest of the batch', () => {
    const hits = parseCollectRequest(
      body({
        site: 4,
        hits: [
          { type: 'pageview', url: 'https://a.test/one' },
          { type: 'nonsense', url: 'https://a.test/two' },
          null,
          'a string',
          { type: 'pageview', url: 'https://a.test/three' },
        ],
      }),
    );
    expect(hits.map((hit) => hit.url)).toEqual(['https://a.test/one', 'https://a.test/three']);
  });

  it('drops an over-long optional field, never the hit carrying it', () => {
    const [hit] = one({ type: 'pageview', url: 'https://a.test/', title: 'x'.repeat(513) });
    expect(hit?.type).toBe('pageview');
    expect(hit?.title).toBeUndefined();
  });

  it('truncates an oversized batch instead of refusing it', () => {
    const hits = Array.from({ length: MAX_COLLECT_HITS + 10 }, (_, i) => ({
      type: 'pageview',
      url: `https://a.test/${i}`,
    }));
    expect(parseCollectRequest(body({ site: 4, hits }))).toHaveLength(MAX_COLLECT_HITS);
  });

  it('ignores fields the collector does not know', () => {
    const [hit] = one({ type: 'ping', url: 'https://a.test/', dimension7: 'whatever' });
    expect(hit).toEqual({ siteId: 4, type: 'ping', url: 'https://a.test/' });
  });

  // The wire format has no say over identity or geo: `visitorId` comes from the
  // server-side hash and `clientIpOverride` from an authenticated sender only.
  it('gives a caller no way to declare its own visitor id or client IP', () => {
    const [hit] = one({
      type: 'pageview',
      url: 'https://a.test/',
      visitorId: '0123456789abcdef',
      clientIpOverride: '203.0.113.9',
      uid: 'someone',
    });
    expect(hit?.visitorId).toBeUndefined();
    expect(hit?.clientIpOverride).toBeUndefined();
    expect(hit?.uid).toBeUndefined();
  });
});
