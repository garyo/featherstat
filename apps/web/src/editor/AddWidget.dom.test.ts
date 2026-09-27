import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button } from '../lib/fake-admin.ts';
import AddWidget from './AddWidget.svelte';

/** The picker says what it cannot build instead of failing silently in the console. */

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

function open() {
  const onadd = vi.fn();
  component = mount(AddWidget, {
    target: document.body,
    props: { id: 'w1', site: 1, onadd, onclose: () => undefined },
  });
  flushSync();
  return { onadd, add: button(document.body, 'Add widget') };
}

function setLimit(value: string): void {
  const input = document.querySelector<HTMLInputElement>('input[type="number"]');
  if (input === null) throw new Error('no limit box');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('AddWidget', () => {
  it('names each visualization in words, not by its id', () => {
    open();
    const labels = [...document.querySelectorAll('option')].map((o) => o.textContent?.trim());
    expect(labels).toContain('Ranked list');
    expect(labels).toContain('KPI row');
    expect(labels).not.toContain('kpi-row');
  });

  it.each(['', '0', '5000'])('explains a limit of "%s" and will not add', (value) => {
    const { onadd, add } = open();
    setLimit(value);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Limit must be a whole number from 1 to 1000.',
    );
    expect(add.disabled).toBe(true);
    add.click();
    expect(onadd).not.toHaveBeenCalled();
  });

  it('adds the widget once the limit is fixed', () => {
    const { onadd, add } = open();
    setLimit('');
    setLimit('25');

    expect(add.disabled).toBe(false);
    add.click();
    expect(onadd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'w1',
        viz: 'bar-list',
        query: expect.objectContaining({ limit: 25 }),
      }),
    );
  });
});
