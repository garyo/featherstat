import type { SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../lib/auth.svelte.ts';
import { button, fakeAdmin, json, settle } from '../lib/fake-admin.ts';
import Shell from './Shell.svelte';

/**
 * The Shell owns the URL and every guarded move, so it is where the Settings
 * view's pieces meet the rest of the app: the open section lives in the URL
 * (reload and Back restore it), and no way out of Settings — a header control,
 * Back, Log out — discards an unsaved form without asking.
 */

const SITES: SiteInfo[] = [{ id: 1, name: 'pcons.org', domains: [], timezone: 'UTC' }];

/** The one stream the Shell opens; nothing here needs it to say anything. */
class SilentEventSource {
  addEventListener(): void {}
  close(): void {}
}

let component: Record<string, unknown> | undefined;
const confirm = vi.fn(() => false);

beforeEach(() => {
  vi.stubGlobal('confirm', confirm);
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal('fetch', async (input: string) => {
    if (input === '/api/sites') return json(200, SITES);
    if (input === '/api/segments') return json(200, []);
    return json(404, { error: `unscripted: ${input}` });
  });
});

afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  confirm.mockReset();
  confirm.mockReturnValue(false);
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(href: string) {
  window.history.replaceState(null, '', href);
  const { admin } = fakeAdmin({
    'GET /api/admin/dashboards': () => [],
    'GET /api/admin/campaigns?site=1': () => [],
    'GET /api/admin/campaign-aliases?site=0': () => [],
  });
  const logout = vi.fn(async () => undefined);
  const auth: AuthState = {
    phase: 'ready',
    error: undefined,
    busy: false,
    role: 'admin',
    email: undefined,
    login: async () => undefined,
    setup: async () => undefined,
    logout,
    unauthorized: () => undefined,
  };
  component = mount(Shell, { target: document.body, props: { admin, auth } });
  await vi.waitFor(() => expect(document.querySelector('.settings-nav')).not.toBeNull());
  await settle();
  return { logout };
}

const heading = (): string | null | undefined => document.querySelector('.card h2')?.textContent;
const search = (): string => new URL(window.location.href).search;

function nav(label: string): void {
  const sections = document.querySelector('nav[aria-label="Settings sections"]');
  if (sections === null) throw new Error('no section nav');
  button(sections, label).click();
  flushSync();
}

/** Simulates the browser having moved back to `href` and told the page. */
function popTo(href: string): void {
  window.history.replaceState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
  flushSync();
}

/** An edit in the Campaigns section that leaving it would lose. */
function typeCampaign(): void {
  button(document.body, 'New campaign').click();
  flushSync();
  const name = document.querySelector<HTMLInputElement>('form input');
  if (name === null) throw new Error('no campaign name box');
  name.value = 'spring-launch';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('the Settings section is part of the URL', () => {
  it('opens the section the URL names', async () => {
    await open('/?view=settings&section=campaigns');
    expect(heading()).toBe('Campaigns');
  });

  it('writes a chosen section to the URL, and Back returns to the previous one', async () => {
    await open('/?view=settings&section=campaigns');
    nav('Sites & tracking');
    expect(search()).toBe('?view=settings&section=sites');
    expect(heading()).toBe('Sites');

    popTo('/?view=settings&section=campaigns');
    await settle();
    expect(heading()).toBe('Campaigns');
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('leaving Settings with an unsaved form asks first', () => {
  it('keeps the form when the header move is refused, and leaves when told to', async () => {
    await open('/?view=settings&section=campaigns');
    typeCampaign();

    document.querySelector<HTMLAnchorElement>('a.wordmark')?.click();
    flushSync();
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to Settings?');
    expect(search()).toBe('?view=settings&section=campaigns');
    expect(heading()).toBe('Campaigns');

    confirm.mockReturnValue(true);
    document.querySelector<HTMLAnchorElement>('a.wordmark')?.click();
    flushSync();
    expect(search()).toBe('');
  });

  it('asks before Back takes the section away, and stays when refused', async () => {
    await open('/?view=settings&section=campaigns');
    typeCampaign();

    popTo('/?view=settings&section=sites');
    expect(confirm).toHaveBeenCalledOnce();
    expect(heading()).toBe('Campaigns');
    expect(search()).toBe('?view=settings&section=campaigns');
  });

  it('asks before Log out, and does not log out when refused', async () => {
    const { logout } = await open('/?view=settings&section=campaigns');
    typeCampaign();

    button(document.body, 'Log out').click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
  });

  it('never asks when nothing was edited', async () => {
    const { logout } = await open('/?view=settings&section=campaigns');
    button(document.body, 'Log out').click();
    expect(confirm).not.toHaveBeenCalled();
    expect(logout).toHaveBeenCalledOnce();
  });
});
