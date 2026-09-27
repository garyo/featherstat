import { DASHBOARD_LAYOUT_VERSION, type Dashboard } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { button, fakeAdmin, settle } from '../lib/fake-admin.ts';
import ShareDialog from './ShareDialog.svelte';

/**
 * A share link is shown exactly once. Closing the dialog before copying one
 * throws it away for good, so the dialog asks — and only then.
 */

const LAYOUT: Dashboard = {
  version: DASHBOARD_LAYOUT_VERSION,
  name: 'Overview',
  site: 1,
  grid: [],
};

/** A store whose dashboard is already a stored row. */
const storedRow = (id: number): DashboardStore => ({
  library: [],
  selection: undefined,
  stored: LAYOUT,
  id,
  ready: true,
  saving: false,
  error: undefined,
  load: () => undefined,
  refresh: async () => undefined,
  save: async () => true,
});

let component: Record<string, unknown> | undefined;
const confirm = vi.fn(() => false);
beforeEach(() => {
  vi.stubGlobal('confirm', confirm);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  confirm.mockClear();
  vi.unstubAllGlobals();
});

async function open() {
  const { admin } = fakeAdmin({
    'POST /api/admin/dashboards/5/share': () => ({ token: 'fs_share_1' }),
  });
  const onclose = vi.fn();
  component = mount(ShareDialog, {
    target: document.body,
    props: { admin, store: storedRow(5), layout: LAYOUT, onclose },
  });
  flushSync();
  const dialog = document.querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  const pressEscape = () => {
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    flushSync();
  };
  return { dialog, onclose, pressEscape };
}

describe('ShareDialog', () => {
  it('closes without asking while no link is on screen', async () => {
    const { onclose, pressEscape } = await open();
    pressEscape();
    expect(confirm).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('asks before throwing away a link nobody copied, and stays when told to', async () => {
    const { dialog, onclose, pressEscape } = await open();
    button(dialog, 'Create share link').click();
    await settle();
    expect(dialog.querySelector('input')?.value).toContain('fs_share_1');

    pressEscape();
    expect(confirm).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();

    button(dialog, 'Copy').click();
    await settle();
    pressEscape();
    expect(confirm).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });
});
