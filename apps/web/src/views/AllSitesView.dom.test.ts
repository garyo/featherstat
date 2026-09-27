import type { QueryRequest, QueryResponse, SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import type { EditorMode } from '../lib/editor-mode.svelte.ts';
import { button } from '../lib/fake-admin.ts';
import type { LiveStream } from '../lib/live.ts';
import type { DashRef, ViewRange } from '../lib/state.ts';
import type { AppEnv } from '../widgets/types.ts';
import AllSitesView from './AllSitesView.svelte';

/**
 * CLAUDE.md invariant 1 on the overview: ONE `/api/query` per view state. The
 * Shell hands this view a new `app` value on every SSE hit, every `active`
 * recount and every clock tick — none of which is a new view state — and the
 * view used to answer each one with a fresh batch (a new site-id array made a
 * new dashboard, a new request, and a cancelled-and-resent query).
 */

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

const site = (id: number): SiteInfo => ({
  id,
  name: `site-${id}.example`,
  domains: [`site-${id}.example`],
  timezone: 'UTC',
});

const SITES = new Map([
  [1, site(1)],
  [2, site(2)],
]);

const app = (active: Record<number, number>, sites = SITES): AppEnv => ({
  now: NOW,
  realtime: { active, recent: [], visitorTimes: [] },
  sites,
  onopenrealtime: () => undefined,
  onselectsite: () => undefined,
});

const RESPONSE: QueryResponse = {
  results: {},
  meta: { generatedInMs: 1, dataVersion: 1, windows: [] },
};

const store: DashboardStore = {
  library: [],
  selection: undefined,
  stored: undefined,
  id: undefined,
  ready: true,
  saving: false,
  error: undefined,
  load: () => undefined,
  refresh: async () => undefined,
  save: async () => false,
};

const mode: EditorMode = {
  Editor: undefined,
  editing: false,
  dirty: false,
  open: async () => undefined,
  close: () => undefined,
  setDirty: () => undefined,
  save: async () => false,
};

const live: LiveStream = { on: () => () => undefined, close: () => undefined };

/** Resolves each query on demand, so a test decides what is still in flight. */
function recordingClient(): { client: QueryClient; sent: QueryRequest[]; settle: () => void } {
  const sent: QueryRequest[] = [];
  const waiting: Array<() => void> = [];
  return {
    sent,
    settle: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
    client: {
      query: (request) => {
        sent.push(request);
        return new Promise((resolve) => waiting.push(() => resolve(RESPONSE)));
      },
    },
  };
}

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
});

interface Extra {
  store?: DashboardStore;
  admin?: AdminClient;
  onselectdash?: (dash: DashRef) => void;
}

/** Mounts the view with an `app` the test can replace, as the Shell does. */
function render(
  client: QueryClient,
  range: () => ViewRange = () => '30d',
  extra: Extra = {},
): (next: AppEnv) => Promise<void> {
  const cell = new SvelteMap<'app', AppEnv>([['app', app({ 1: 3 })]]);
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(AllSitesView, {
      target,
      props: {
        get app() {
          return cell.get('app') as AppEnv;
        },
        admin: extra.admin ?? ({} as AdminClient),
        client,
        live,
        store: extra.store ?? store,
        mode,
        get range() {
          return range();
        },
        cmp: 'previous',
        onselectrange: () => undefined,
        onselectcmp: () => undefined,
        onselectdash: extra.onselectdash ?? (() => undefined),
      },
    }),
  );
  flushSync();
  return async (next) => {
    cell.set('app', next);
    flushSync();
    await Promise.resolve();
  };
}

describe('the all-sites overview batches once per view state', () => {
  it('sends one query on load and none for stream updates', async () => {
    const { client, sent, settle } = recordingClient();
    const update = render(client);
    expect(sent).toHaveLength(1);

    // Six hits and a recount while the first batch is still in flight …
    for (let n = 4; n < 10; n += 1) await update(app({ 1: n }));
    await update(app({ 1: 2, 2: 1 }));
    settle();
    await Promise.resolve();
    // … and after it landed.
    for (let n = 1; n < 4; n += 1) await update(app({ 2: n }));

    expect(sent).toHaveLength(1);
  });

  it('re-batches when the site set itself changes', async () => {
    const { client, sent } = recordingClient();
    const update = render(client);
    await update(app({}, new Map([...SITES, [3, site(3)]])));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.queries.map((query) => query.id)).toContain('sites~pages~3');
  });
});

describe('the overview labels the data on screen, not the range being loaded', () => {
  it('says what it is showing when a range change fails', async () => {
    let fail = false;
    const client: QueryClient = {
      query: async () => {
        if (fail) throw new Error('503');
        return RESPONSE;
      },
    };
    const pill = new SvelteMap<'range', ViewRange>([['range', '30d']]);
    render(client, () => pill.get('range') ?? '30d');
    await vi.waitFor(() =>
      expect(document.querySelector('.compare-note')?.textContent).toMatch(/previous 30 days/),
    );

    fail = true;
    pill.set('range', '7d');
    flushSync();
    await vi.waitFor(() =>
      expect(document.querySelector('.compare-note')?.textContent).toBe(
        "Couldn't load last 7 days — showing last 30 days",
      ),
    );
  });
});

describe('sharing the built-in overview', () => {
  it('moves the view onto the row the first share saved, so a second share reuses it', async () => {
    let id: number | undefined;
    const saving: DashboardStore = {
      ...store,
      save: async () => {
        id = 7;
        return true;
      },
      get id() {
        return id;
      },
    };
    const onselectdash = vi.fn();
    const { client } = recordingClient();
    render(client, undefined, {
      store: saving,
      admin: { createShareLink: async () => ({ token: 't' }) } as unknown as AdminClient,
      onselectdash,
    });

    button(document.body, 'Share').click();
    await vi.waitFor(() => button(document.body, 'Create share link'));
    button(document.body, 'Create share link').click();

    await vi.waitFor(() => expect(onselectdash).toHaveBeenCalledWith(7));
  });
});
