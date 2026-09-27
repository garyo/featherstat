import type { Dashboard, QueryRequest, QueryResponse, SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { builtTemplate } from '../lib/dashboards.ts';
import { createEditorMode, type EditorMode } from '../lib/editor-mode.svelte.ts';
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
  dirty: false,
  open: async () => undefined,
  close: () => undefined,
  setDirty: () => undefined,
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

interface Setup {
  store: DashboardStore;
  pivots?: PivotChoice[];
  mode?: EditorMode;
  /** Read reactively, so a test can move the page to another site. */
  site?: () => number;
}

function render({
  store,
  pivots = [],
  mode: editorMode = mode,
  site = () => 1,
}: Setup): HTMLElement {
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
        mode: editorMode,
        get site() {
          return site();
        },
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
    const root = render({
      store: templateStore(save),
      pivots: [{ widget: 'pages', dim: 'country' }],
    });

    button(root, 'Share').click();
    await vi.waitFor(() => button(document.body, 'Create share link'));
    button(document.body, 'Create share link').click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    const pages = save.mock.calls[0]?.[0].grid.find((spec) => spec.id === 'pages');
    expect(pages?.query).toMatchObject({ dim: 'path' });
  });
});

describe('an editor draft belongs to one dashboard', () => {
  /** Each site has its own stored row, named for it. */
  const layoutOf = (site: number): Dashboard => ({
    ...builtTemplate('overview', site),
    name: `Dashboard of site ${site}`,
  });

  it('remounts on another site, never carrying the old draft over', async () => {
    const at = new SvelteMap([['site', 3]]);
    const site = (): number => at.get('site') ?? 3;
    const store: DashboardStore = {
      ...templateStore(async () => true),
      get stored() {
        return layoutOf(site());
      },
      get selection() {
        const name = `Dashboard of site ${site()}`;
        return {
          kind: 'stored' as const,
          ref: site(),
          name,
          info: {
            id: site(),
            name,
            site: site(),
            template: null,
            createdAt: 0,
            updatedAt: 0,
            shareCount: 0,
          },
        };
      },
    };
    const editorMode = createEditorMode(store, site);
    const root = render({ store, mode: editorMode, site });
    await editorMode.open();
    flushSync();
    expect(root.querySelector('.ename')?.textContent).toBe('Dashboard of site 3');
    expect(editorMode.dirty).toBe(false);

    root.querySelector<HTMLButtonElement>('button[title="Remove widget"]')?.click();
    flushSync();
    expect(editorMode.dirty).toBe(true);

    // Back/forward (had the reader said yes) — the draft of site 3 must not
    // survive onto site 1, where Save would have written it.
    at.set('site', 1);
    flushSync();
    expect(root.querySelector('.ename')?.textContent).toBe('Dashboard of site 1');
    expect(editorMode.dirty).toBe(false);
  });
});
