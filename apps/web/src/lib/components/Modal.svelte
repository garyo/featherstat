<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * The app's one overlay grammar: a native modal `<dialog>`, so the browser
 * supplies what a hand-built overlay has to fake — Tab stays inside and the
 * page behind is inert. Opening focuses the first control of the content (not
 * the ×, which is how the browser would choose); closing hands focus back to
 * whatever opened it.
 *
 * A backdrop click, the ×, and Escape all ask `onrequestclose` first when one
 * is given, so a dialog holding work the reader would lose — an unapplied
 * expression, pasted JSON, a link shown once — can ask before it goes.
 */
interface Props {
  title: string;
  /** `wide` for panels with rows of controls — a confirm width wraps them. */
  size?: 'default' | 'wide';
  onclose: () => void;
  /** False keeps the dialog open; omitted, every close request is granted. */
  onrequestclose?: () => boolean;
  children: Snippet;
}

let { title, size = 'default', onclose, onrequestclose, children }: Props = $props();

let dialog: HTMLDialogElement;
let content: HTMLDivElement;
/** Set while unmounting, so our own `close()` is not read as a request. */
let released = false;
/** Where a click began: a drag that starts inside and ends on the backdrop is not a dismissal. */
let pressedBackdrop = false;

function requestClose(): void {
  if (onrequestclose === undefined || onrequestclose()) onclose();
}

const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

$effect(() => {
  const opener = document.activeElement;
  dialog.showModal();
  if (!content.contains(document.activeElement)) {
    (content.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
  }
  return () => {
    released = true;
    dialog.close();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
});
</script>

<dialog
  bind:this={dialog}
  class:wide={size === 'wide'}
  aria-label={title}
  tabindex="-1"
  oncancel={(event) => {
    event.preventDefault();
    requestClose();
  }}
  onclose={() => {
    // A browser may close a modal on a repeated Escape without a cancel event.
    if (released) return;
    if (onrequestclose === undefined || onrequestclose()) onclose();
    else dialog.showModal();
  }}
  onpointerdown={(event) => (pressedBackdrop = event.target === dialog)}
  onclick={(event) => {
    if (event.target === dialog && pressedBackdrop) requestClose();
  }}
>
  <div class="panel">
    <div class="head">
      <h2>{title}</h2>
      <button class="icon-btn" type="button" aria-label="Close" onclick={requestClose}>×</button>
    </div>
    <div bind:this={content}>{@render children()}</div>
  </div>
</dialog>

<style>
  dialog {
    width: min(560px, calc(100% - 40px));
    padding: 0;
    overflow: hidden;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
  }

  dialog.wide {
    width: min(780px, calc(100% - 40px));
  }

  dialog::backdrop {
    background: color-mix(in srgb, var(--ink, #000) 32%, transparent);
  }

  /* Padding and scrolling live here, not on the dialog: a click whose target is
   * the dialog itself is then always the backdrop, never its padding or scrollbar. */
  .panel {
    max-height: min(80vh, calc(100vh - 40px));
    overflow: auto;
    padding: 16px 18px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .head h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
