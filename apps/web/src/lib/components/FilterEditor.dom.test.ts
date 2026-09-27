import type { FilterNode } from '@featherstat/shared';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button } from '../fake-admin.ts';
import FilterEditor from './FilterEditor.svelte';

/** Closing without Apply asks first — but only when there is an edit to lose. */

const FILTERS: FilterNode[] = [{ dim: 'country', op: 'eq', value: 'NZ' }];

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

function open(): { onclose: () => void } {
  const onclose = vi.fn();
  component = mount(FilterEditor, {
    target: document.body,
    props: { filters: FILTERS, onapply: () => undefined, onclose },
  });
  flushSync();
  return { onclose };
}

function close(): void {
  document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
  flushSync();
}

describe('FilterEditor close guard', () => {
  it('closes without asking when the expression is as it was opened', () => {
    const { onclose } = open();
    button(document.body, 'Edit as text').click(); // printing and re-reading is no edit
    flushSync();
    close();
    expect(confirm).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('asks before an edited expression is thrown away, and stays when told to', () => {
    const { onclose } = open();
    button(document.body, 'Edit as text').click();
    flushSync();
    const text = document.querySelector('textarea');
    if (text === null) throw new Error('no text box');
    expect(text.value).toContain('NZ');
    text.value = text.value.replace('NZ', 'AU'); // still a valid expression, now a different one
    text.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    close();
    expect(confirm).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();
  });
});
