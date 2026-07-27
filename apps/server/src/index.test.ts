import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb } from '../test/rows.ts';
import type { Db } from './db/index.ts';
import { createApp } from './index.ts';

const assetsDir = mkdtempSync(join(tmpdir(), 'app-tracker-dist-'));
writeFileSync(join(assetsDir, 'matomo.js'), '"use strict";(()=>{})();');

let db: Db;

beforeEach(() => {
  db = openTestDb(2);
});

afterEach(() => {
  db.close();
});

describe('app', () => {
  it('serves /healthz', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves the tracker bundles with no db behind them', async () => {
    const res = await createApp({ assetsDir }).request('/matomo.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('mounts the site directory when a db is given', async () => {
    const res = await createApp({ db, assetsDir }).request('/api/sites');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
  });

  it('leaves the site directory unmounted when tracking alone runs', async () => {
    expect((await createApp().request('/api/sites')).status).toBe(404);
  });
});
