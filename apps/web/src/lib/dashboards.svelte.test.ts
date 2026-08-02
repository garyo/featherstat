import { DASHBOARD_LAYOUT_VERSION, type Dashboard } from '@featherstat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminClient } from './admin.ts';
import { createDashboardStore } from './dashboards.svelte.ts';
import type { DashboardDetail, DashboardInfo } from './dashboards.ts';

/**
 * The store runs on Svelte runes, which are compile-time sugar; outside the
 * Svelte compiler `$state(v)` is just an identity call, which is exactly enough
 * to test the async sequencing here (reactivity itself is Svelte's contract).
 */
vi.stubGlobal('$state', <T>(value: T): T => value);

const LAYOUT: Dashboard = {
  version: DASHBOARD_LAYOUT_VERSION,
  name: 'Overview',
  site: 1,
  grid: [],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const info = (id: number): DashboardInfo => ({
  id,
  name: 'Overview',
  site: 1,
  template: null,
  createdAt: 1,
  updatedAt: 1,
  shareCount: 0,
});
const detail = (id: number): DashboardDetail => ({ ...info(id), layout: LAYOUT });

let list: Deferred<DashboardInfo[]>;
let get: Deferred<DashboardDetail>;
let created: { layout: Dashboard; template: string | undefined }[];
let updated: Array<{ id: number; layout: Dashboard }>;

function fakeAdmin(): AdminClient {
  const client: Pick<
    AdminClient,
    'listDashboards' | 'getDashboard' | 'createDashboard' | 'updateDashboard'
  > = {
    listDashboards: () => list.promise,
    getDashboard: () => get.promise,
    createDashboard: (layout, template) => {
      created.push({ layout, template });
      return Promise.resolve(detail(99));
    },
    updateDashboard: (id, layout) => {
      updated.push({ id, layout });
      return Promise.resolve({ ...detail(id), layout });
    },
  };
  return client as AdminClient;
}

beforeEach(() => {
  list = deferred();
  get = deferred();
  created = [];
  updated = [];
});

describe('createDashboardStore save/load sequencing', () => {
  it('a save racing the initial load waits for it and PUTs the existing row', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1, undefined);
    // Save is clicked before the lookup answered: it must not create row two.
    const saving = store.save(LAYOUT);
    list.resolve([info(7)]);
    get.resolve(detail(7));
    expect(await saving).toBe(true);
    expect(created).toEqual([]);
    expect(updated).toEqual([{ id: 7, layout: LAYOUT }]);
    expect(store.id).toBe(7);
  });

  it('creates the first row only when the scope truly has none', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1, undefined);
    const saving = store.save(LAYOUT);
    list.resolve([]);
    expect(await saving).toBe(true);
    // The default selection is the shipped overview template — the clone
    // records its lineage, so it can be reset later.
    expect(created).toEqual([{ layout: LAYOUT, template: 'overview' }]);
    expect(updated).toEqual([]);
    expect(store.id).toBe(99);
  });

  it('keeps the row id when the detail read fails, so a save repairs the row', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1, undefined);
    list.resolve([info(3)]);
    get.reject(new Error('stored dashboard 3 is invalid'));
    await vi.waitFor(() => expect(store.ready).toBe(true));
    // The default layout is shown (stored is unreadable) but the row is known.
    expect(store.stored).toBeUndefined();
    expect(store.id).toBe(3);
    expect(await store.save(LAYOUT)).toBe(true);
    expect(created).toEqual([]);
    expect(updated).toEqual([{ id: 3, layout: LAYOUT }]);
  });
});

describe('createDashboardStore library resolution', () => {
  it('an explicit template ref selects the template and loads no row', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1, 't:content');
    list.resolve([info(7)]);
    await vi.waitFor(() => expect(store.ready).toBe(true));
    expect(store.selection?.ref).toBe('t:content');
    expect(store.id).toBeUndefined();
    expect(store.stored).toBeUndefined();
    // Saving while a template is up CLONES it with its lineage.
    expect(await store.save(LAYOUT)).toBe(true);
    expect(created).toEqual([{ layout: LAYOUT, template: 'content' }]);
    expect(store.id).toBe(99);
  });

  it('exposes the scope library for the switcher, templates first', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load('all', undefined);
    list.resolve([]);
    await vi.waitFor(() => expect(store.ready).toBe(true));
    expect(store.library.map((entry) => entry.ref)).toEqual(['t:all-sites']);
    expect(store.selection?.ref).toBe('t:all-sites');
  });

  it('the list failing still readies the view — the shipped default renders', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1, undefined);
    list.reject(new Error('offline'));
    await vi.waitFor(() => expect(store.ready).toBe(true));
    expect(store.selection).toBeUndefined();
    expect(store.stored).toBeUndefined();
  });
});
