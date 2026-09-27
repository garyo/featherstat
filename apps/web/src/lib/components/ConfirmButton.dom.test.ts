import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, settle } from '../fake-admin.ts';
import ConfirmButton, { CONFIRM_WINDOW_MS } from './ConfirmButton.svelte';

/** The gate every irreversible verb in the app goes through. */

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function render(onconfirm: () => Promise<void> | void) {
  component = mount(ConfirmButton, {
    target: document.body,
    props: { label: 'Revoke', confirm: 'Really revoke?', pending: 'Revoking…', onconfirm },
  });
  const found = document.querySelector('button');
  if (found === null) throw new Error('no button');
  const click = () => {
    found.click();
    flushSync();
  };
  return { button: found, click };
}

describe('ConfirmButton', () => {
  it('asks on the first click and acts only on the second', async () => {
    const onconfirm = vi.fn();
    const { button, click } = render(onconfirm);

    click();
    expect(onconfirm).not.toHaveBeenCalled();
    expect(button.textContent?.trim()).toBe('Really revoke?');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Really revoke? Press again to confirm.',
    );

    click();
    await settle();
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(button.textContent?.trim()).toBe('Revoke');
  });

  it('cannot send the action twice while it is running', async () => {
    const answer = deferred<void>();
    const onconfirm = vi.fn(() => answer.promise);
    const { button, click } = render(onconfirm);

    click();
    click();
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('Revoking…');
    click();
    click();
    expect(onconfirm).toHaveBeenCalledOnce();

    answer.resolve();
    await settle();
    expect(button.disabled).toBe(false);
  });

  it('lapses back to rest, so a much later click only asks again', () => {
    vi.useFakeTimers();
    const onconfirm = vi.fn();
    const { button, click } = render(onconfirm);

    click();
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS);
    flushSync();
    expect(button.textContent?.trim()).toBe('Revoke');
    click();
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it('takes Escape as "no" without letting it reach the dialog around it', () => {
    const onconfirm = vi.fn();
    const { button, click } = render(onconfirm);
    const outside = vi.fn();
    window.addEventListener('keydown', outside);

    click();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(button.textContent?.trim()).toBe('Revoke');
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
  });
});
