import { describe, expect, it } from 'vitest';
import { createApp } from './index.ts';

describe('app', () => {
  it('serves /healthz', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
