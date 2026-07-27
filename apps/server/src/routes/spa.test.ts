import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAssetCache, createSpaRoutes } from './spa.ts';

const dir = mkdtempSync(join(tmpdir(), 'spa-'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'export {};');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createAssetCache', () => {
  it('is bounded by the bundle: attacker-chosen paths never become cache keys', () => {
    const cache = createAssetCache(dir);
    expect(cache.get('/')?.type).toContain('text/html');
    expect(cache.get('/assets/app-abc123.js')?.type).toContain('javascript');
    const before = cache.size();
    for (let i = 0; i < 5_000; i++) {
      // Navigation paths resolve to the shared index asset …
      expect(cache.get(`/some/deep/client/route-${i}`)).toBeDefined();
      // … and misses with extensions are answered but never remembered.
      expect(cache.get(`/assets/missing-${i}.js`)).toBeUndefined();
    }
    expect(cache.size()).toBe(before + 1); // exactly the '/index.html' fallback entry
  });
});

describe('createSpaRoutes', () => {
  const app = createSpaRoutes({ dir });

  it('serves index at /, hashed assets immutable, SPA fallback on navigation paths', async () => {
    expect((await app.request('/')).status).toBe(200);
    const asset = await app.request('/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const fallback = await app.request('/client/route');
    expect(await fallback.text()).toContain('id="app"');
    expect((await app.request('/assets/missing.js')).status).toBe(404);
  });
});
