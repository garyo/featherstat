import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Modal from './Modal.svelte';

/**
 * The overlay every dialog in the app renders. What it owes the reader: focus
 * inside while it is up and back where it was after, and a close that asks
 * first when the dialog says there is something to lose.
 */

let component: Record<string, unknown> | undefined;
afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

const body = createRawSnippet(() => ({ render: () => '<input aria-label="Name" />' }));

function open(props: { onrequestclose?: () => boolean } = {}) {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const onclose = vi.fn(() => {
    if (component !== undefined) unmount(component);
    component = undefined;
    flushSync();
  });
  component = mount(Modal, {
    target: document.body,
    props: { title: 'Rename', onclose, children: body, ...props },
  });
  flushSync();
  const dialog = document.querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  return { opener, dialog, onclose };
}

const pressEscape = (dialog: HTMLDialogElement): void => {
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  flushSync();
};

describe('Modal', () => {
  it('opens as a native modal dialog, labelled, focused on its first control', () => {
    const { dialog } = open();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Rename');
    expect(document.activeElement).toBe(dialog.querySelector('input'));
    // The old overlay's backdrop was a full-screen button — the first Tab stop.
    expect(document.querySelectorAll('button[aria-label="Close"]')).toHaveLength(1);
  });

  it('hands focus back to what opened it', () => {
    const { opener, dialog } = open();
    pressEscape(dialog);
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape, the ×, and a click on the backdrop', () => {
    for (const close of [
      (dialog: HTMLDialogElement) => pressEscape(dialog),
      (dialog: HTMLDialogElement) => dialog.querySelector<HTMLButtonElement>('.icon-btn')?.click(),
      (dialog: HTMLDialogElement) => {
        dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        dialog.click();
      },
    ]) {
      const { dialog, onclose } = open();
      close(dialog);
      expect(onclose).toHaveBeenCalledOnce();
    }
  });

  it('does not take a drag that ends on the backdrop as a dismissal', () => {
    const { dialog, onclose } = open();
    dialog
      .querySelector('input')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    dialog.click();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('asks before closing when there is work to lose, and stays when told to', () => {
    let keep = true;
    const onrequestclose = vi.fn(() => !keep);
    const { dialog, onclose } = open({ onrequestclose });

    pressEscape(dialog);
    dialog.querySelector<HTMLButtonElement>('.icon-btn')?.click();
    expect(onrequestclose).toHaveBeenCalledTimes(2);
    expect(onclose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    keep = false;
    pressEscape(dialog);
    expect(onclose).toHaveBeenCalledOnce();
  });
});
