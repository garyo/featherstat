import { type DashboardInfo, overviewTemplate } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '../lib/dashboards.ts';
import { button, fakeAdmin, settle } from '../lib/fake-admin.ts';
import ManageDashboards from './ManageDashboards.svelte';

/** Reset and delete both throw a layout away, so neither acts on one click. */

const INFO: DashboardInfo = {
  id: 7,
  name: 'My overview',
  site: 1,
  template: 'overview',
  createdAt: 0,
  updatedAt: 0,
  shareCount: 2,
};
const CLONE: LibraryEntry = { kind: 'stored', ref: 7, name: 'My overview', info: INFO };

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

function open() {
  const { admin, calls } = fakeAdmin({
    // A real row: the client checks what it reads (DashboardDetailSchema).
    'POST /api/admin/dashboards/7/reset': () => ({
      ...INFO,
      layout: overviewTemplate.build(1),
    }),
    'DELETE /api/admin/dashboards/7': () => undefined,
  });
  const onchanged = vi.fn(async () => undefined);
  const onselectdash = vi.fn();
  component = mount(ManageDashboards, {
    target: document.body,
    props: {
      admin,
      scope: 1,
      library: [CLONE],
      dash: 7,
      onchanged,
      onselectdash,
      onclose: () => undefined,
    },
  });
  flushSync();
  return { calls, onchanged, onselectdash };
}

describe('ManageDashboards', () => {
  it('resets a clone only on the second click', async () => {
    const { calls, onchanged } = open();

    button(document.body, 'Reset').click();
    flushSync();
    expect(calls).toEqual([]);

    button(document.body, 'Really reset to the built-in layout?').click();
    await settle();
    expect(calls.map((call) => call.route)).toEqual(['POST /api/admin/dashboards/7/reset']);
    expect(onchanged).toHaveBeenCalledOnce();
  });

  it('says what deleting revokes before it deletes', async () => {
    const { calls, onselectdash } = open();

    button(document.body, 'Delete').click();
    flushSync();
    expect(calls).toEqual([]);

    button(document.body, 'Really delete — and revoke 2 share links?').click();
    await settle();
    expect(calls.map((call) => call.route)).toEqual(['DELETE /api/admin/dashboards/7']);
    expect(onselectdash).toHaveBeenCalledWith(undefined);
  });
});
