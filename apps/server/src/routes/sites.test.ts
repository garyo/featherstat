import { SiteInfoSchema } from '@featherstat/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb } from '../../test/rows.ts';
import type { Db } from '../db/index.ts';
import { createSiteRoutes } from './sites.ts';

let db: Db;
let app: Hono;

beforeEach(() => {
  db = openTestDb(2);
  app = new Hono().route('/', createSiteRoutes(db));
});

afterEach(() => {
  db.close();
});

describe('GET /api/sites', () => {
  it('lists every site in id order, matching the shared contract', async () => {
    const res = await app.request('/api/sites');
    expect(res.status).toBe(200);
    const raw = (await res.json()) as unknown[];
    const body = raw.map((site) => SiteInfoSchema.parse(site));
    expect(body).toEqual([
      { id: 1, name: 'one', domains: ['one.test'], timezone: 'America/New_York' },
      { id: 2, name: 'two', domains: ['two.test'], timezone: 'America/New_York' },
    ]);
  });

  it('projects exactly the contract fields — no created_at leak', async () => {
    const res = await app.request('/api/sites');
    const body = (await res.json()) as Array<Record<string, unknown>>;
    for (const site of body) {
      expect(Object.keys(site).sort()).toEqual(['domains', 'id', 'name', 'timezone']);
    }
  });
});
