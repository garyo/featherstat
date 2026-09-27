import type { Dashboard, QueryRequest, QueryResponse, SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import type { EditorMode } from '../lib/editor-mode.svelte.ts';
import type { LiveStream } from '../lib/live.ts';
import type { PivotChoice } from '../lib/state.ts';
import type { AppEnv } from '../widgets/types.ts';
import SiteView from './SiteView.svelte';

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

const SITE: SiteInfo = {
  id: 1,
  name: 'site-1.example',
  domains: ['site-1.example'],
  timezone: 'UTC',
};

const APP: AppEnv = {
  now: NOW,
  realtime: { active: {}, recent: [], visitorTimes: [] },
  sites: new Map([[1, SITE]]),
  onopenrealtime: () => undefined,
  onselectsite: () => undefined,
};

const RESPONSE: QueryResponse = {
  results: {},
  meta: { generatedInMs: 1, dataVersion: 1, windows: [] },
};

const client: QueryClient = {
  query: async (_request: QueryRequest) => RESPONSE,
};

const live: LiveStream = { on: () => () => undefined, close: () => undefined };

const mode: EditorMode = {
  Editor: undefined,
  editing: false,
  open: async () => undefined,
  close: () => undefined,
  save: async () => false,
};

/** The shipped overview, still a template: sharing it saves a row first. */
function templateStore(save: (layout: Dashboard) => Promise<boolean>): DashboardStore {
  return {
    library: [],
    selection: undefined,
    stored: undefined,
    id: undefined,
    ready: true,
    saving: false,
    error: undefined,
    load: () => undefined,
    refresh: async () => undefined,
    save,
  };
}

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
});

function render(store: DashboardStore, pivots: PivotChoice[]): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(SiteView, {
      target,
      props: {
        app: APP,
        admin: { createShareLink: async () => ({ token: 't' }) } as unknown as AdminClient,
        client,
        live,
        store,
        mode,
        site: 1,
        timezone: 'UTC',
        range: '30d',
        cmp: 'previous',
        filters: [],
        pivots,
        onselectrange: () => undefined,
        onselectcmp: () => undefined,
        onselectdash: () => undefined,
        onfilters: () => undefined,
        onpivots: () => undefined,
        onopendetail: () => undefined,
      },
    }),
  );
  flushSync();
  return target;
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
}

describe('sharing a pivoted dashboard', () => {
  it('saves the layout as stored, never the transient pivot (docs/05 § Pivots)', async () => {
    const save = vi.fn(async (_layout: Dashboard) => false);
    const root = render(templateStore(save), [{ widget: 'pages', dim: 'country' }]);

    button(root, 'Share').click();
    await vi.waitFor(() => button(document.body, 'Create share link'));
    button(document.body, 'Create share link').click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    const pages = save.mock.calls[0]?.[0].grid.find((spec) => spec.id === 'pages');
    expect(pages?.query).toMatchObject({ dim: 'path' });
  });
});
