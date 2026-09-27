import { allSitesTemplate, type DashboardInfo, overviewTemplate } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { createAdminClient } from './admin.ts';
import { builtTemplate, libraryFor, resolveDashRef, withLiveSiteIds } from './dashboards.ts';

const siteOverview = overviewTemplate.build(1);
const allSites = (siteIds: readonly number[]) => allSitesTemplate.build('all', siteIds);

function info(
  id: number,
  site: DashboardInfo['site'],
  over: Partial<DashboardInfo> = {},
): DashboardInfo {
  return {
    id,
    name: `d${id}`,
    site,
    template: null,
    createdAt: id,
    updatedAt: id,
    shareCount: 0,
    ...over,
  };
}

describe('libraryFor', () => {
  it('lists the scope templates first, then stored rows oldest-created first', () => {
    const list = [info(9, 3, { createdAt: 50 }), info(4, 3, { createdAt: 70 }), info(7, 1)];
    const library = libraryFor(list, 3);
    expect(library.map((entry) => entry.ref)).toEqual([
      't:overview',
      't:content',
      't:acquisition',
      't:campaigns',
      9,
      4,
    ]);
    expect(library[0]?.kind).toBe('template');
  });

  it('breaks a created_at tie by row id, so the order is deterministic', () => {
    const list = [info(9, 3, { createdAt: 5 }), info(4, 3, { createdAt: 5 })];
    expect(
      libraryFor(list, 3)
        .filter((entry) => entry.kind === 'stored')
        .map((entry) => entry.ref),
    ).toEqual([4, 9]);
  });

  it("the all-sites scope lists only the all-sites template, and only 'all' rows", () => {
    const library = libraryFor([info(2, 'all'), info(3, 1)], 'all');
    expect(library.map((entry) => entry.ref)).toEqual(['t:all-sites', 2]);
  });
});

describe('resolveDashRef', () => {
  const library = libraryFor([info(9, 3, { createdAt: 50 }), info(4, 3, { createdAt: 70 })], 3);

  it('absent resolves to the oldest stored row — exactly the v1 singleton rule', () => {
    expect(resolveDashRef(library, undefined)?.ref).toBe(9);
  });

  it('absent with no stored rows resolves to the shipped default template', () => {
    expect(resolveDashRef(libraryFor([], 3), undefined)?.ref).toBe('t:overview');
    expect(resolveDashRef(libraryFor([], 'all'), undefined)?.ref).toBe('t:all-sites');
  });

  it('a named row or template wins over the default', () => {
    expect(resolveDashRef(library, 4)?.ref).toBe(4);
    expect(resolveDashRef(library, 't:content')?.ref).toBe('t:content');
  });

  it('a ref the scope does not have falls back to the default, not an error', () => {
    expect(resolveDashRef(library, 999)?.ref).toBe(9);
    expect(resolveDashRef(library, 't:nope')?.ref).toBe(9);
  });
});

describe('builtTemplate', () => {
  it('builds the named template for the scope', () => {
    expect(builtTemplate('content', 5).name).toBe('Content');
    expect(builtTemplate('content', 5).site).toBe(5);
  });

  it('falls back to the scope default on an unknown or absent id', () => {
    expect(builtTemplate(undefined, 5).name).toBe('Site overview');
    expect(builtTemplate('nope', 5).name).toBe('Site overview');
    expect(builtTemplate(undefined, 'all', [1, 2]).grid[0]?.options.siteIds).toEqual([1, 2]);
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

  it('creates with POST (template as a query param) and updates with PUT, CSRF aboard', async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (String(input) === '/api/admin/me') {
        return json(200, { authenticated: true, needsSetup: false, csrf: 'tok' });
      }
      return json(200, { ...info(5, 1), layout: siteOverview });
    }) as typeof fetch;
    const admin = createAdminClient({ fetch: fetchImpl });
    await admin.me();

    const created = await admin.createDashboard(siteOverview, 'overview');
    expect(created.id).toBe(5);
    expect(calls[1]?.input).toBe('/api/admin/dashboards?template=overview');
    expect(calls[1]?.init?.method).toBe('POST');
    const headers = (calls[1]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');

    await admin.createDashboard(siteOverview);
    expect(calls[2]?.input).toBe('/api/admin/dashboards');

    await admin.updateDashboard(5, siteOverview);
    expect(calls[3]?.input).toBe('/api/admin/dashboards/5');
    expect(calls[3]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[3]?.init?.body)).name).toBe(siteOverview.name);

    await admin.duplicateDashboard(5);
    expect(calls[4]?.input).toBe('/api/admin/dashboards/5/duplicate');
    expect(calls[4]?.init?.method).toBe('POST');
    await admin.resetDashboard(5);
    expect(calls[5]?.input).toBe('/api/admin/dashboards/5/reset');
    await admin.deleteDashboard(5);
    expect(calls[6]?.init?.method).toBe('DELETE');
  });
});
