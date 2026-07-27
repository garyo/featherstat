import type { Hit, HitContext } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { clientIp, createTrackRoutes, MAX_TRACK_BODY_BYTES, trustedProxyHops } from './track.ts';

const QUERY = '/matomo.php?idsite=1&rec=1&url=https%3A%2F%2Fexample.com%2F';

function capture() {
  const batches: Hit[][] = [];
  const contexts: HitContext[] = [];
  const app = createTrackRoutes((hits, ctx) => {
    batches.push(hits);
    contexts.push(ctx);
  });
  return { app, batches, contexts };
}

describe('client IP resolution (feeds the visitor hash — invariant 3 material)', () => {
  it('takes the LAST x-forwarded-for entry with one trusted hop — the leading entries are client-typed', async () => {
    const { app, contexts } = capture();
    await app.request(QUERY, {
      // A spoofer sends "6.6.6.6"; the (one) trusted proxy appends the real peer.
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-real-ip': '198.51.100.2' },
    });
    expect(contexts[0]?.ip).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent, then to the socket/empty', async () => {
    const { app, contexts } = capture();
    await app.request(QUERY, { headers: { 'x-real-ip': '198.51.100.2' } });
    await app.request(QUERY);
    expect(contexts[0]?.ip).toBe('198.51.100.2');
    expect(contexts[1]?.ip).toBe('');
  });

  const fakeContext = (headers: Record<string, string>) =>
    ({
      req: { header: (name: string) => headers[name.toLowerCase()] },
    }) as unknown as Parameters<typeof clientIp>[0];

  it('counts trusted hops from the END of x-forwarded-for', () => {
    const c = fakeContext({ 'x-forwarded-for': 'fake, 203.0.113.9, 10.0.0.7' });
    expect(clientIp(c, 1)).toBe('10.0.0.7');
    expect(clientIp(c, 2)).toBe('203.0.113.9');
  });

  it('never trusts a header when fewer entries than hops arrived, or with hops=0', () => {
    // Fewer entries than trusted hops: the chain was bypassed — socket only.
    expect(clientIp(fakeContext({ 'x-forwarded-for': 'fake' }), 2)).toBe('');
    // hops=0 (no proxy): forwarded headers are attacker-supplied, ignored.
    const direct = fakeContext({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.7' });
    expect(clientIp(direct, 0)).toBe('');
  });

  it('parses TRUSTED_PROXY_HOPS with a default of 1 and rejects garbage', () => {
    expect(trustedProxyHops({})).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '-3' })).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'lots' })).toBe(1);
  });
});

describe('body cap (invariant 4: oversize is discarded, never bounced)', () => {
  it('drops an oversized POST body but still answers 204 and records the query hit', async () => {
    const { app, batches } = capture();
    const huge = 'a'.repeat(MAX_TRACK_BODY_BYTES + 1);
    const res = await app.request(`${QUERY}&send_image=0`, { method: 'POST', body: huge });
    expect(res.status).toBe(204);
    // The query-string hit survives; the body's contents were never parsed.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('still accepts a normal bulk body', async () => {
    const { app, batches } = capture();
    const res = await app.request('/matomo.php', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: ['?idsite=1&rec=1&url=https%3A%2F%2Fexample.com%2Fa'] }),
    });
    expect(res.status).toBe(200);
    expect(batches[0]).toHaveLength(1);
  });
});

describe('responses', () => {
  it('marks both response styles no-store', async () => {
    const { app } = capture();
    const gif = await app.request(QUERY);
    expect(gif.status).toBe(200);
    expect(gif.headers.get('cache-control')).toBe('no-store');
    const empty = await app.request(`${QUERY}&send_image=0`);
    expect(empty.status).toBe(204);
    expect(empty.headers.get('cache-control')).toBe('no-store');
  });

  it('never calls the sink when no hit was understood', async () => {
    const { app, batches } = capture();
    const res = await app.request('/matomo.php?idsite=1&url=https%3A%2F%2Fexample.com%2F'); // no rec=1
    expect(res.status).toBe(200);
    expect(batches).toHaveLength(0);
  });
});
