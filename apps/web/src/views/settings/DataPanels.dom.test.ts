import type { AdminDataSettings } from '@featherstat/shared';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { button, fakeAdmin, settle } from '../../lib/fake-admin.ts';
import DataPanels from './DataPanels.svelte';

/**
 * The retention/backup card as a reader drives it. Its number boxes bind
 * numbers, and a save that treated them as strings threw before any request
 * left — so these edit the field, press Save, and read what reached the server.
 */

const STORED: AdminDataSettings = { retentionDays: null, backupDir: null, backupKeep: 7 };

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

async function open() {
  const { admin, calls } = fakeAdmin({
    'GET /api/admin/data-settings': () => STORED,
    'PUT /api/admin/data-settings': (body) => body,
  });
  component = mount(DataPanels, { target: document.body, props: { admin, sites: [] } });
  await settle();
  const card = [...document.querySelectorAll('.card')].find((el) =>
    el.textContent?.includes('Retention'),
  );
  if (card === undefined) throw new Error('no retention card');
  const [retention, , keep] = [...card.querySelectorAll('input')];
  if (retention === undefined || keep === undefined) throw new Error('missing inputs');
  return { card, retention, keep, calls };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const saved = (calls: { route: string; body: unknown }[]) =>
  calls.filter((call) => call.route === 'PUT /api/admin/data-settings').map((call) => call.body);

describe('Retention & backups', () => {
  it('saves the numbers typed into the number boxes', async () => {
    const { card, retention, keep, calls } = await open();
    type(retention, '90');
    type(keep, '14');
    button(card, 'Save data settings').click();
    await settle();

    expect(saved(calls)).toEqual([{ retentionDays: 90, backupDir: null, backupKeep: 14 }]);
    expect(card.textContent).toContain('Saved.');
  });

  it('reads a cleared retention box as keep-forever', async () => {
    const { card, retention, calls } = await open();
    type(retention, '30');
    type(retention, '');
    button(card, 'Save data settings').click();
    await settle();

    expect(saved(calls)).toEqual([{ retentionDays: null, backupDir: null, backupKeep: 7 }]);
  });

  it('says what is missing instead of sending an empty backup count', async () => {
    const { card, keep, calls } = await open();
    type(keep, '');
    card.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(saved(calls)).toEqual([]);
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('how many backups');
  });
});

describe('Excluded traffic', () => {
  it('names every rule input, since the row has no visible label', async () => {
    const { admin } = fakeAdmin({
      'GET /api/admin/exclusions': () => ({
        rules: [{ value: '198.51.100.0/24', note: 'office' }],
        resolutions: [],
      }),
    });
    component = mount(DataPanels, { target: document.body, props: { admin, sites: [] } });
    await settle();
    const labels = [...document.querySelectorAll('.xrow input')].map((input) =>
      input.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Excluded address 1', 'Note for excluded address 1']);
  });
});
