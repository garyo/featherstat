import { describe, expect, it, vi } from 'vitest';
import { AdminError, createAdminClient } from './admin.ts';
import { panelFailure, SIGNED_OUT_MESSAGE } from './admin-failure.ts';
import { type AdminObjects, adminObjects } from './admin-objects.ts';

interface Call {
  input: string;
  init: RequestInit | undefined;
}

function objects(): { api: AdminObjects; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ rules: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { api: adminObjects(createAdminClient({ fetch: fetchImpl })), calls };
}

describe('adminObjects', () => {
  it('sends every admin-object call to the exact server route', async () => {
    // The route contract for the Settings panels: each entry is (call, method,
    // path[, body sent]) — a drifted path 404s in production, so it fails here.
    const cases: Array<{
      run: (api: AdminObjects) => Promise<unknown>;
      method: string;
      path: string;
      body?: unknown;
    }> = [
      { run: (a) => a.listTokens(), method: 'GET', path: '/api/admin/tokens' },
      {
        run: (a) => a.createToken({ name: 't', sites: 'all' }),
        method: 'POST',
        path: '/api/admin/tokens',
        body: { name: 't', sites: 'all' },
      },
      { run: (a) => a.revokeToken(4), method: 'DELETE', path: '/api/admin/tokens/4' },
      { run: (a) => a.listViewers(), method: 'GET', path: '/api/admin/viewers' },
      {
        run: (a) => a.inviteViewer({ email: 'x@y.z', sites: [1] }),
        method: 'POST',
        path: '/api/admin/viewers',
        body: { email: 'x@y.z', sites: [1] },
      },
      { run: (a) => a.reinviteViewer(2), method: 'POST', path: '/api/admin/viewers/2/invite' },
      { run: (a) => a.revokeViewer(2), method: 'DELETE', path: '/api/admin/viewers/2' },
      { run: (a) => a.listSegments(), method: 'GET', path: '/api/admin/segments' },
      {
        run: (a) => a.createSegment({ name: 's', filter: { dim: 'path', op: 'eq', value: '/' } }),
        method: 'POST',
        path: '/api/admin/segments',
      },
      {
        run: (a) =>
          a.updateSegment(7, { name: 's', filter: { dim: 'path', op: 'eq', value: '/' } }),
        method: 'PUT',
        path: '/api/admin/segments/7',
      },
      { run: (a) => a.deleteSegment(7), method: 'DELETE', path: '/api/admin/segments/7' },
      { run: (a) => a.listDerivedMetrics(), method: 'GET', path: '/api/admin/derived-metrics' },
      {
        run: (a) => a.createDerivedMetric({ name: 'epv', expr: 'events / visits' }),
        method: 'POST',
        path: '/api/admin/derived-metrics',
      },
      {
        run: (a) => a.updateDerivedMetric(3, { name: 'epv', expr: 'events / visits' }),
        method: 'PUT',
        path: '/api/admin/derived-metrics/3',
      },
      {
        run: (a) => a.deleteDerivedMetric(3),
        method: 'DELETE',
        path: '/api/admin/derived-metrics/3',
      },
      { run: (a) => a.listGoals(2), method: 'GET', path: '/api/admin/goals?site=2' },
      {
        run: (a) =>
          a.createGoal(2, {
            name: 'g',
            filters: [{ dim: 'event_category', op: 'eq', value: 'signup' }],
            valueExpr: null,
            target: null,
          }),
        method: 'POST',
        path: '/api/admin/goals?site=2',
      },
      {
        run: (a) =>
          a.updateGoal(5, {
            name: 'g',
            filters: [{ dim: 'event_category', op: 'eq', value: 'signup' }],
            valueExpr: null,
            target: null,
          }),
        method: 'PUT',
        path: '/api/admin/goals/5',
      },
      { run: (a) => a.deleteGoal(5), method: 'DELETE', path: '/api/admin/goals/5' },
      { run: (a) => a.listCampaigns(1), method: 'GET', path: '/api/admin/campaigns?site=1' },
      {
        run: (a) =>
          a.createCampaign(1, {
            name: 'launch',
            expectedSources: null,
            expectedMediums: null,
            startsAt: null,
            endsAt: null,
            notes: null,
          }),
        method: 'POST',
        path: '/api/admin/campaigns?site=1',
      },
      {
        run: (a) =>
          a.updateCampaign(9, {
            name: 'launch',
            expectedSources: null,
            expectedMediums: null,
            startsAt: null,
            endsAt: null,
            notes: null,
          }),
        method: 'PUT',
        path: '/api/admin/campaigns/9',
      },
      { run: (a) => a.deleteCampaign(9), method: 'DELETE', path: '/api/admin/campaigns/9' },
      {
        run: (a) => a.listCampaignAliases(0),
        method: 'GET',
        path: '/api/admin/campaign-aliases?site=0',
      },
      {
        run: (a) =>
          a.saveCampaignAliases(1, [{ field: 'source', alias: 'tw', canonical: 'twitter' }]),
        method: 'PUT',
        path: '/api/admin/campaign-aliases?site=1',
        body: [{ field: 'source', alias: 'tw', canonical: 'twitter' }],
      },
      { run: (a) => a.listAnnotations(), method: 'GET', path: '/api/admin/annotations' },
      { run: (a) => a.listAnnotations(3), method: 'GET', path: '/api/admin/annotations?site=3' },
      {
        run: (a) => a.createAnnotation({ siteId: null, ts: 5, text: 'deploy' }),
        method: 'POST',
        path: '/api/admin/annotations',
      },
      {
        run: (a) => a.updateAnnotation(6, { siteId: 1, ts: 5, text: 'deploy' }),
        method: 'PUT',
        path: '/api/admin/annotations/6',
      },
      { run: (a) => a.deleteAnnotation(6), method: 'DELETE', path: '/api/admin/annotations/6' },
      { run: (a) => a.alertRules(), method: 'GET', path: '/api/admin/alerts' },
      { run: (a) => a.props(2), method: 'GET', path: '/api/admin/props?site=2' },
      { run: (a) => a.deletePropKey(2, 'plan'), method: 'DELETE', path: '/api/admin/props/2/plan' },
      { run: (a) => a.dataSettings(), method: 'GET', path: '/api/admin/data-settings' },
      {
        run: (a) => a.saveDataSettings({ retentionDays: 90, backupDir: '/b', backupKeep: 7 }),
        method: 'PUT',
        path: '/api/admin/data-settings',
        body: { retentionDays: 90, backupDir: '/b', backupKeep: 7 },
      },
    ];
    for (const entry of cases) {
      const { api, calls } = objects();
      await entry.run(api);
      expect(calls[0]?.input, `${entry.method} ${entry.path}`).toBe(entry.path);
      expect(calls[0]?.init?.method ?? 'GET', entry.path).toBe(entry.method);
      if (entry.body !== undefined) {
        expect(JSON.parse(String(calls[0]?.init?.body)), entry.path).toEqual(entry.body);
      }
    }
  });

  it('rejects a mutation the session no longer covers, as the failure panels render', async () => {
    // The reported bug: a revoke refused with 401 resolved as far as the panel
    // could tell. It must throw, report the expired session, and map to prose.
    const onUnauthorized = vi.fn();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const api = adminObjects(createAdminClient({ fetch: fetchImpl, onUnauthorized }));
    const failure = await api.revokeToken(4).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminError);
    expect(panelFailure(failure, 'Revoking failed — try again.')).toEqual({
      message: SIGNED_OUT_MESSAGE,
      urgent: true,
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('unwraps the alert rules envelope both ways', async () => {
    const { api, calls } = objects();
    await expect(api.alertRules()).resolves.toEqual([]);
    expect(calls[0]?.input).toBe('/api/admin/alerts');
    await expect(api.saveAlertRules([])).resolves.toEqual([]);
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ rules: [] });
  });
});
