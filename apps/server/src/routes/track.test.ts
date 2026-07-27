import type { Hit, HitContext } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { createTrackRoutes } from './track.ts';

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
  it('takes the first hop of x-forwarded-for over x-real-ip', async () => {
    const { app, contexts } = capture();
    await app.request(QUERY, {
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.1', 'x-real-ip': '198.51.100.2' },
    });
    expect(contexts[0]?.ip).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then to an empty string', async () => {
    const { app, contexts } = capture();
    await app.request(QUERY, { headers: { 'x-real-ip': '198.51.100.2' } });
    await app.request(QUERY);
    expect(contexts[0]?.ip).toBe('198.51.100.2');
    expect(contexts[1]?.ip).toBe('');
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
