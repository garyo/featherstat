import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompareChoice, ViewRange } from '../state.ts';
import FilterRow from './FilterRow.svelte';

/** The custom-date editors: bounded by today, applied by Enter, and honest when abandoned. */

const TODAY = '2026-07-30';

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
});

function render(
  handlers: {
    onselect?: (range: ViewRange) => void;
    oncompare?: (cmp: CompareChoice) => void;
  } = {},
): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(FilterRow, {
      target,
      props: {
        range: '30d',
        cmp: 'previous',
        note: 'compared with the previous 30 days',
        today: TODAY,
        onselect: handlers.onselect ?? (() => undefined),
        oncompare: handlers.oncompare ?? (() => undefined),
      },
    }),
  );
  flushSync();
  return target;
}

const input = (root: HTMLElement, label: string): HTMLInputElement => {
  const found = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`no "${label}" input`);
  return found;
};

function type(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function pickCompare(root: HTMLElement, value: string): HTMLSelectElement {
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare"]');
  if (select === null) throw new Error('no compare select');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  return select;
}

describe('the custom range editor', () => {
  it('offers no date after today', () => {
    const root = render();
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
    flushSync();
    expect(input(root, 'From date').max).toBe(TODAY);
    expect(input(root, 'To date').max).toBe(TODAY);
  });

  it('applies on Enter, as a form does', () => {
    const onselect = vi.fn();
    const root = render({ onselect });
    root.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
    flushSync();
    type(input(root, 'From date'), '2026-07-01');
    type(input(root, 'To date'), '2026-07-14');
    input(root, 'To date').form?.requestSubmit();
    flushSync();
    expect(onselect).toHaveBeenCalledWith({ from: '2026-07-01', to: '2026-07-14' });
  });
});

describe('an abandoned custom compare window', () => {
  it('puts the select back on the comparison in force when Escape closes it', () => {
    const oncompare = vi.fn();
    const root = render({ oncompare });
    const select = pickCompare(root, 'custom');
    expect(input(root, 'Compare to date').max).toBe(TODAY);

    input(root, 'Compare from date').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    flushSync();
    expect(select.value).toBe('previous');
    expect(root.querySelector('input[aria-label="Compare from date"]')).toBeNull();
    expect(oncompare).not.toHaveBeenCalled();
  });

  it('does the same when focus moves on to another control', () => {
    const root = render();
    const select = pickCompare(root, 'custom');
    const preset = root.querySelector<HTMLButtonElement>('button.preset');
    input(root, 'Compare from date').dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: preset }),
    );
    flushSync();
    expect(select.value).toBe('previous');
  });

  it('stays open while focus moves between its own dates', () => {
    const root = render();
    pickCompare(root, 'custom');
    input(root, 'Compare from date').dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: input(root, 'Compare to date') }),
    );
    flushSync();
    expect(root.querySelector('input[aria-label="Compare to date"]')).not.toBeNull();
  });
});
