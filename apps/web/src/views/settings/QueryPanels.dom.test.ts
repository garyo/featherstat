import type { GoalInfo, SiteInfo } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { button, deferred, fakeAdmin, json, settle } from '../../lib/fake-admin.ts';
import QueryPanels from './QueryPanels.svelte';

/**
 * A settings list is about the site its picker shows, and a failed read can be
 * tried again — the goals card is the one with both a picker and a list.
 */

const site = (id: number): SiteInfo => ({ id, name: `site-${id}`, domains: [], timezone: 'UTC' });
const goal = (id: number, name: string): GoalInfo => ({
  id,
  siteId: id,
  name,
  filters: [{ dim: 'path', op: 'eq', value: '/thanks' }],
  valueExpr: null,
  target: null,
  updatedAt: 0,
});

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

function goalsCard(): Element {
  const card = [...document.querySelectorAll('.card')].find(
    (el) => el.querySelector('h2')?.textContent === 'Goals',
  );
  if (card === undefined) throw new Error('no goals card');
  return card;
}

function pickSite(id: number): void {
  const select = goalsCard().querySelector('select');
  if (select === null) throw new Error('no site picker');
  select.value = String(id);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

describe('Goals', () => {
  it('never shows the site it left, however late its answer comes', async () => {
    const first = deferred<GoalInfo[]>();
    const second = deferred<GoalInfo[]>();
    const { admin } = fakeAdmin({
      'GET /api/admin/goals?site=1': () => first.promise,
      'GET /api/admin/goals?site=2': () => second.promise,
    });
    component = mount(QueryPanels, {
      target: document.body,
      props: { admin, sites: [site(1), site(2)], role: 'user' },
    });
    await settle();

    pickSite(2);
    second.resolve([goal(2, 'Signed up on two')]);
    await settle();
    first.resolve([goal(1, 'Bought on one')]);
    await settle();

    expect(goalsCard().textContent).toContain('Signed up on two');
    expect(goalsCard().textContent).not.toContain('Bought on one');
  });

  it('offers Retry after a failed read, and a retry that works clears the failure', async () => {
    let up = false;
    const { admin } = fakeAdmin({
      'GET /api/admin/goals?site=1': () =>
        up ? [goal(1, 'Came back')] : json(500, { error: 'boom' }),
    });
    component = mount(QueryPanels, {
      target: document.body,
      props: { admin, sites: [site(1)], role: 'user' },
    });
    await settle();
    expect(goalsCard().textContent).toContain('Goals unavailable.');

    up = true;
    button(goalsCard(), 'Retry').click();
    await settle();
    expect(goalsCard().textContent).not.toContain('unavailable');
    expect(goalsCard().textContent).toContain('Came back');
  });
});
