import type { ApiTokenInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { button, deferred, fakeAdmin, settle } from '../../lib/fake-admin.ts';
import AccessPanels from './AccessPanels.svelte';

/** Revoking a token breaks whatever script holds it — it asks, and it sends once. */

const TOKEN: ApiTokenInfo = {
  id: 4,
  name: 'nightly-export',
  sites: 'all',
  createdAt: 0,
  lastUsedAt: null,
  revokedAt: null,
};

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

describe('API token revoke', () => {
  it('asks first, then sends one DELETE however fast the clicks come', async () => {
    const answer = deferred<unknown>();
    let tokens = [TOKEN];
    const { admin, calls } = fakeAdmin({
      'GET /api/admin/tokens': () => tokens,
      'DELETE /api/admin/tokens/4': async () => {
        await answer.promise;
        tokens = [];
      },
    });
    component = mount(AccessPanels, { target: document.body, props: { admin, sites: [] } });
    await settle();
    const revokes = () => calls.filter((call) => call.route === 'DELETE /api/admin/tokens/4');

    button(document.body, 'Revoke').click();
    flushSync();
    expect(revokes()).toEqual([]);

    const armed = button(document.body, 'Really revoke? Scripts using it stop working.');
    armed.click();
    armed.click();
    armed.click();
    flushSync();
    expect(armed.disabled).toBe(true);
    expect(revokes()).toHaveLength(1);

    answer.resolve(undefined);
    await settle();
    expect(document.body.textContent).toContain('No live tokens.');
  });
});
