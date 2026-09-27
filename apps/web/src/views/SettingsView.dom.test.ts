import type { SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, fakeAdmin, settle } from '../lib/fake-admin.ts';
import type { SettingsSection } from '../lib/state.ts';
import SettingsView from './SettingsView.svelte';

/**
 * The section nav: which section is open comes from the URL, a choice goes back
 * to it, and a choice that would discard an edit asks first.
 */

const SITES: SiteInfo[] = [{ id: 1, name: 'pcons.org', domains: [], timezone: 'UTC' }];

let component: Record<string, unknown> | undefined;
const confirm = vi.fn(() => false);
beforeEach(() => vi.stubGlobal('confirm', confirm));
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  confirm.mockClear();
  vi.unstubAllGlobals();
});

async function open(section?: SettingsSection) {
  const { admin } = fakeAdmin({
    'GET /api/admin/campaigns?site=1': () => [],
    'GET /api/admin/campaign-aliases?site=0': () => [],
  });
  const onselectsection = vi.fn();
  component = mount(SettingsView, {
    target: document.body,
    props: { admin, sites: SITES, onsiteschanged: () => undefined, section, onselectsection },
  });
  await settle();
  const heading = () => document.querySelector('.card h2')?.textContent;
  return { onselectsection, heading };
}

const nav = (label: string): void => {
  const nav = document.querySelector('nav[aria-label="Settings sections"]');
  if (nav === null) throw new Error('no section nav');
  button(nav, label).click();
  flushSync();
};

describe('SettingsView sections', () => {
  it('opens the section the URL names', async () => {
    const { heading } = await open('campaigns');
    expect(heading()).toBe('Campaigns');
  });

  it('opens the first section when the URL names none', async () => {
    const { heading } = await open();
    expect(heading()).toBe('Sites');
  });

  it('hands a chosen section to the URL instead of keeping it', async () => {
    const { onselectsection } = await open();
    nav('Campaigns');
    expect(onselectsection).toHaveBeenCalledWith('campaigns');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before a switch would discard an edit, and stays when told to', async () => {
    const { onselectsection, heading } = await open('campaigns');
    button(document.body, 'New campaign').click();
    flushSync();
    nav('Data');
    expect(confirm).not.toHaveBeenCalled(); // an untouched form loses nothing

    const name = document.querySelector<HTMLInputElement>('form input');
    if (name === null) throw new Error('no campaign name box');
    name.value = 'spring-launch';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    onselectsection.mockClear();

    nav('Data');
    expect(confirm).toHaveBeenCalledOnce();
    expect(onselectsection).not.toHaveBeenCalled();
    expect(heading()).toBe('Campaigns');
  });
});
