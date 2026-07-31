import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAssetRoutes } from './assets.ts';

const dir = mkdtempSync(join(tmpdir(), 'tracker-dist-'));
const app = createAssetRoutes({ dir });

beforeAll(() => {
  writeFileSync(join(dir, 'matomo.js'), '"use strict";(()=>{})();');
  writeFileSync(join(dir, 'tracker.js'), 'export{a as init};');
});

describe('tracker bundles', () => {
  it('serves matomo.js cacheable, typed and tagged', async () => {
    const res = await app.request('/matomo.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('"use strict";(()=>{})();');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(res.headers.get('etag')).toMatch(/^"[\w-]+"$/);
  });

  it('serves piwik.js as the same bundle', async () => {
    const matomo = await app.request('/matomo.js');
    const piwik = await app.request('/piwik.js');
    expect(await piwik.text()).toBe(await matomo.text());
    expect(piwik.headers.get('etag')).toBe(matomo.headers.get('etag'));
  });

  it('serves the native tracker', async () => {
    const res = await app.request('/tracker.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('export{a as init};');
  });

  /**
   * A module script is always fetched in CORS mode, so a bare 200 is not enough
   * for `tracker.js`: without this header every site gets "Failed to fetch
   * dynamically imported module" while curl of the same URL looks perfectly
   * healthy. The 304 path carries it too, or the revalidated fetch fails.
   */
  it('lets another origin import the bundles, fresh and revalidated', async () => {
    for (const path of ['/matomo.js', '/piwik.js', '/tracker.js']) {
      const res = await app.request(path);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      const etag = res.headers.get('etag') ?? '';
      const revalidated = await app.request(path, { headers: { 'if-none-match': etag } });
      expect(revalidated.status, path).toBe(304);
      expect(revalidated.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await app.request('/matomo.js');
    const etag = first.headers.get('etag') ?? '';
    const revalidated = await app.request('/matomo.js', { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expect(revalidated.headers.get('cache-control')).toBe('public, max-age=86400');
    const stale = await app.request('/matomo.js', { headers: { 'if-none-match': '"other"' } });
    expect(stale.status).toBe(200);
  });

  it('404s a bundle that has not been built', async () => {
    const empty = createAssetRoutes({ dir: join(dir, 'missing') });
    expect((await empty.request('/matomo.js')).status).toBe(404);
  });
});
