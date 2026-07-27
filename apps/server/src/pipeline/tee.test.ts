import type { Hit, HitContext } from '@analytics/shared';
import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, T0 } from '../../test/rows.ts';
import { parseMatomoRequest } from '../ingest/matomo.ts';
import type { HitSink } from './index.ts';
import { createTeeSink, teeSinkFromEnv } from './tee.ts';

const FORWARD_URL = 'https://matomo.test/matomo.php';

function hit(overrides: Partial<Hit> = {}): Hit {
  return { siteId: 1, type: 'pageview', url: 'https://example.com/a?x=1', ...overrides };
}

function ctx(overrides: Partial<HitContext> = {}): HitContext {
  return { ip: '203.0.113.5', userAgent: DESKTOP_UA, receivedAt: T0, ...overrides };
}

interface Sent {
  url: string;
  body: string;
}

/** A fetch stub whose promises resolve only when the test says so. */
function deferredFetch(): {
  calls: Sent[];
  resolveNext: () => void;
  fetchFn: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<unknown>;
} {
  const calls: Sent[] = [];
  const resolvers: Array<() => void> = [];
  return {
    calls,
    resolveNext: () => resolvers.shift()?.(),
    fetchFn: (url, init) => {
      calls.push({ url, body: init.body });
      return new Promise((resolve) => resolvers.push(() => resolve(undefined)));
    },
  };
}

function requestsOf(body: string): URLSearchParams[] {
  const parsed = JSON.parse(body) as { requests: string[] };
  return parsed.requests.map((entry) => new URLSearchParams(entry.slice(1)));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTeeSink', () => {
  it('calls the real sink synchronously, before any forwarding', () => {
    const inner = vi.fn<HitSink>();
    const { fetchFn, calls } = deferredFetch();
    const tee = createTeeSink(inner, { forwardUrl: FORWARD_URL, fetchFn });

    const hits = [hit()];
    const context = ctx();
    tee.sink(hits, context);

    expect(inner).toHaveBeenCalledExactlyOnceWith(hits, context);
    expect(calls).toHaveLength(0); // forward starts on a microtask, never inline
  });

  it('forwards a hit in Matomo bulk format with cip, ua, cdt and bulk-level token_auth only', async () => {
    const { fetchFn, calls } = deferredFetch();
    const tee = createTeeSink(() => {}, {
      forwardUrl: FORWARD_URL,
      tokenAuth: 'secret-token',
      fetchFn,
    });
    tee.sink([hit({ title: 'A page', referrer: 'https://ref.test/' })], ctx());
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FORWARD_URL);
    const body = JSON.parse(calls[0]?.body ?? '') as { requests: string[]; token_auth?: string };
    expect(body.token_auth).toBe('secret-token');
    const params = requestsOf(calls[0]?.body ?? '')[0];
    expect(params?.get('idsite')).toBe('1');
    expect(params?.get('rec')).toBe('1');
    expect(params?.get('url')).toBe('https://example.com/a?x=1');
    expect(params?.get('action_name')).toBe('A page');
    expect(params?.get('urlref')).toBe('https://ref.test/');
    expect(params?.get('cip')).toBe('203.0.113.5');
    // Never per-request: those strings end up verbatim in Matomo/proxy logs.
    expect(params?.get('token_auth')).toBeNull();
    expect(params?.get('ua')).toBe(DESKTOP_UA);
    expect(params?.get('cdt')).toBe(String(Math.floor(T0 / 1000)));
  });

  it("forwards the sender's own cip override, not the transport peer", async () => {
    const { fetchFn, calls } = deferredFetch();
    const tee = createTeeSink(() => {}, { forwardUrl: FORWARD_URL, fetchFn });
    // A server-side webhook: transport peer is the worker's egress, cip is the visitor.
    tee.sink([hit({ clientIpOverride: '198.51.100.77' })], ctx({ ip: '203.0.113.5' }));
    await flush();
    expect(requestsOf(calls[0]?.body ?? '')[0]?.get('cip')).toBe('198.51.100.77');
  });

  it('serializes every hit type back to its matomo.php params', async () => {
    const { fetchFn, calls } = deferredFetch();
    const tee = createTeeSink(() => {}, { forwardUrl: FORWARD_URL, fetchFn });
    tee.sink(
      [
        hit({
          type: 'event',
          event: { category: 'Video', action: 'play', name: 'intro', value: 2.5 },
        }),
        hit({ type: 'outlink', targetUrl: 'https://other.org/' }),
        hit({ type: 'download', targetUrl: 'https://example.com/f.pdf' }),
        hit({ type: 'ping', screen: '1920x1080', lang: 'en-US', visitorId: 'abcdef0123456789' }),
      ],
      ctx(),
    );
    await flush();

    const [event, outlink, download, ping] = requestsOf(calls[0]?.body ?? '');
    expect(event?.get('e_c')).toBe('Video');
    expect(event?.get('e_a')).toBe('play');
    expect(event?.get('e_n')).toBe('intro');
    expect(event?.get('e_v')).toBe('2.5');
    expect(outlink?.get('link')).toBe('https://other.org/');
    expect(download?.get('download')).toBe('https://example.com/f.pdf');
    expect(ping?.get('ping')).toBe('1');
    expect(ping?.get('res')).toBe('1920x1080');
    expect(ping?.get('lang')).toBe('en-US');
    expect(ping?.get('_id')).toBe('abcdef0123456789');
  });

  it('round-trips: the forwarded body re-parses to the original hit', async () => {
    const { fetchFn, calls } = deferredFetch();
    const tee = createTeeSink(() => {}, { forwardUrl: FORWARD_URL, fetchFn });
    const original = hit({
      type: 'event',
      title: 'Page',
      event: { category: 'Cat', action: 'Act', value: 7 },
    });
    tee.sink([original], ctx());
    await flush();

    const { hits } = parseMatomoRequest({
      query: new URLSearchParams(),
      body: calls[0]?.body ?? '',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      siteId: original.siteId,
      type: 'event',
      url: original.url,
      title: 'Page',
      event: { category: 'Cat', action: 'Act', value: 7 },
      clientIpOverride: '203.0.113.5',
    });
  });

  it('drops the oldest queued payloads when the upstream is slow, never blocking', async () => {
    const inner = vi.fn<HitSink>();
    const { fetchFn, calls, resolveNext } = deferredFetch();
    const tee = createTeeSink(inner, {
      forwardUrl: FORWARD_URL,
      fetchFn,
      maxInFlight: 1,
      maxPending: 2,
    });

    for (let i = 1; i <= 5; i += 1) {
      tee.sink([hit({ url: `https://example.com/${i}` })], ctx());
    }
    await flush();

    // 1 in flight + 2 queued; hits 2 and 3 were evicted oldest-first.
    expect(inner).toHaveBeenCalledTimes(5); // local ingest saw everything
    expect(calls).toHaveLength(1);
    expect(tee.stats()).toMatchObject({ dropped: 2, pending: 3 });

    resolveNext();
    await flush();
    resolveNext();
    await flush();
    resolveNext();
    await flush();

    expect(calls.map((c) => requestsOf(c.body)[0]?.get('url'))).toEqual([
      'https://example.com/1',
      'https://example.com/4',
      'https://example.com/5',
    ]);
    expect(tee.stats()).toMatchObject({ forwarded: 3, dropped: 2, pending: 0 });
  });

  it('counts upstream failures and keeps forwarding afterwards', async () => {
    const bodies: string[] = [];
    let failures = 1;
    const fetchFn = async (_url: string, init: { body: string }): Promise<unknown> => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('upstream down');
      }
      bodies.push(init.body);
      return {};
    };
    const tee = createTeeSink(() => {}, { forwardUrl: FORWARD_URL, fetchFn });
    tee.sink([hit()], ctx());
    await flush();
    tee.sink([hit()], ctx());
    await flush();

    expect(tee.stats()).toMatchObject({ forwarded: 1, failed: 1, dropped: 0 });
    expect(bodies).toHaveLength(1);
  });

  it('counts an HTTP error response as failed, not forwarded', async () => {
    // A Matomo answering 403 (bad token) must not read as a healthy bake.
    const fetchFn = async (): Promise<unknown> => ({ ok: false, status: 403 });
    const tee = createTeeSink(() => {}, { forwardUrl: FORWARD_URL, fetchFn });
    tee.sink([hit()], ctx());
    await flush();
    expect(tee.stats()).toMatchObject({ forwarded: 0, failed: 1 });
  });

  it('survives a fetch that throws synchronously', async () => {
    const tee = createTeeSink(() => {}, {
      forwardUrl: FORWARD_URL,
      fetchFn: () => {
        throw new Error('boom');
      },
    });
    expect(() => tee.sink([hit()], ctx())).not.toThrow();
    await flush();
    expect(tee.stats()).toMatchObject({ failed: 1 });
  });
});

describe('teeSinkFromEnv', () => {
  it('is inert without MATOMO_FORWARD_URL and wired with it', () => {
    expect(teeSinkFromEnv(() => {}, {})).toBeUndefined();
    const tee = teeSinkFromEnv(() => {}, {
      MATOMO_FORWARD_URL: FORWARD_URL,
      MATOMO_TOKEN_AUTH: 'secret',
    });
    expect(tee).toBeDefined();
  });

  it('refuses a plain-http forward URL unless loopback — token_auth rides the body', () => {
    expect(() =>
      teeSinkFromEnv(() => {}, { MATOMO_FORWARD_URL: 'http://matomo.example.com/matomo.php' }),
    ).toThrow(/https/);
    expect(
      teeSinkFromEnv(() => {}, { MATOMO_FORWARD_URL: 'http://127.0.0.1:8081/matomo.php' }),
    ).toBeDefined();
    expect(
      teeSinkFromEnv(() => {}, { MATOMO_FORWARD_URL: 'http://localhost:8081/matomo.php' }),
    ).toBeDefined();
  });
});
