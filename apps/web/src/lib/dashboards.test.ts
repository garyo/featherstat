import { describe, expect, it } from 'vitest';
import { allSites } from '../dashboards/all-sites.ts';
import { siteOverview } from '../dashboards/site-overview.ts';
import { createAdminClient } from './admin.ts';
import { type DashboardInfo, storedDashboardFor, withLiveSiteIds } from './dashboards.ts';

function info(id: number, site: DashboardInfo['site']): DashboardInfo {
  return { id, name: `d${id}`, site, updatedAt: id };
}

describe('storedDashboardFor', () => {
  it('picks the oldest row for the scope — extras never displace the canonical one', () => {
    const list = [info(9, 3), info(4, 3), info(2, 'all'), info(7, 1)];
    expect(storedDashboardFor(list, 3)?.id).toBe(4);
    expect(storedDashboardFor(list, 'all')?.id).toBe(2);
    expect(storedDashboardFor(list, 1)?.id).toBe(7);
  });

  it('answers undefined when no row matches — the shipped default renders', () => {
    expect(storedDashboardFor([info(1, 2)], 5)).toBeUndefined();
    expect(storedDashboardFor([], 'all')).toBeUndefined();
  });

  it('never lets a numbered scope match all or vice versa', () => {
    const list = [info(1, 'all')];
    expect(storedDashboardFor(list, 1)).toBeUndefined();
  });
});

describe('withLiveSiteIds', () => {
  it('refreshes a stored site-cards widget to the live directory', () => {
    const stored = allSites([1, 2]);
    const fresh = withLiveSiteIds(stored, [1, 2, 3]);
    expect(fresh.grid[0]?.options.siteIds).toEqual([1, 2, 3]);
    expect(stored.grid[0]?.options.siteIds).toEqual([1, 2]); // input untouched
  });

  it('returns the same object when the ids already match — derived state stays stable', () => {
    const stored = allSites([1, 2]);
    expect(withLiveSiteIds(stored, [1, 2])).toBe(stored);
  });

  it('leaves dashboards without site-cards alone', () => {
    expect(withLiveSiteIds(siteOverview, [1, 2])).toBe(siteOverview);
  });
});

describe('dashboard admin client', () => {
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('creates with POST and updates with PUT to the id path, CSRF aboard', async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (String(input) === '/api/admin/me') {
        return json(200, { authenticated: true, needsSetup: false, csrf: 'tok' });
      }
      return json(200, { id: 5, name: 'X', site: 1, updatedAt: 1, layout: siteOverview });
    }) as typeof fetch;
    const admin = createAdminClient({ fetch: fetchImpl });
    await admin.me();

    const created = await admin.createDashboard(siteOverview);
    expect(created.id).toBe(5);
    expect(calls[1]?.input).toBe('/api/admin/dashboards');
    expect(calls[1]?.init?.method).toBe('POST');
    const headers = (calls[1]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');

    await admin.updateDashboard(5, siteOverview);
    expect(calls[2]?.input).toBe('/api/admin/dashboards/5');
    expect(calls[2]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[2]?.init?.body)).name).toBe(siteOverview.name);
  });
});
