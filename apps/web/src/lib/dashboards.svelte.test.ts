import type { Dashboard } from '@analytics/shared';
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

const LAYOUT: Dashboard = { name: 'Overview', site: 1, grid: [] };

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

const info = (id: number): DashboardInfo => ({ id, name: 'Overview', site: 1, updatedAt: 1 });
const detail = (id: number): DashboardDetail => ({ ...info(id), layout: LAYOUT });

let list: Deferred<DashboardInfo[]>;
let get: Deferred<DashboardDetail>;
let created: Dashboard[];
let updated: Array<{ id: number; layout: Dashboard }>;

function fakeAdmin(): AdminClient {
  const client: Pick<
    AdminClient,
    'listDashboards' | 'getDashboard' | 'createDashboard' | 'updateDashboard'
  > = {
    listDashboards: () => list.promise,
    getDashboard: () => get.promise,
    createDashboard: (layout) => {
      created.push(layout);
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
    store.load(1);
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
    store.load(1);
    const saving = store.save(LAYOUT);
    list.resolve([]);
    expect(await saving).toBe(true);
    expect(created).toEqual([LAYOUT]);
    expect(updated).toEqual([]);
    expect(store.id).toBe(99);
  });

  it('keeps the row id when the detail read fails, so a save repairs the row', async () => {
    const store = createDashboardStore(fakeAdmin());
    store.load(1);
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
