import { type SharePayload, templatesForScope } from '@featherstat/shared';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../lib/fake-admin.ts';
import ShareView from './ShareView.svelte';

/**
 * The share page reads a body nobody signed in to ask for, so it checks what
 * arrived before a widget reads it: a payload it cannot read says so plainly
 * rather than handing the grid half a dashboard.
 */

const TOKEN = 'A'.repeat(43);

let component: Record<string, unknown> | undefined;

afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function open(body: unknown): Promise<void> {
  vi.stubGlobal('fetch', async () => json(200, body));
  component = mount(ShareView, { target: document.body, props: { token: TOKEN } });
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading…'));
}

describe('the share page', () => {
  it('renders a payload it can read', async () => {
    const template = templatesForScope('site')[0];
    if (template === undefined) throw new Error('no site template');
    const payload: SharePayload = {
      dashboard: { ...template.build(1), name: 'Launch week' },
      results: {},
      meta: { generatedInMs: 1, dataVersion: 0, windows: [] },
    };
    await open(payload);
    expect(document.body.textContent).toContain('Launch week');
  });

  it('says it could not load a payload that is not one', async () => {
    await open({ dashboard: { name: 'Launch week' }, results: [], meta: null });
    expect(document.body.textContent).toContain('This shared dashboard could not be loaded.');
    expect(document.body.textContent).not.toContain('Launch week');
  });
});
