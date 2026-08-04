<script lang="ts">
import type { Snippet } from 'svelte';

/** The app's one overlay grammar: backdrop click, ×, or Escape closes. */
interface Props {
  title: string;
  /** `wide` for panels with rows of controls — a confirm width wraps them. */
  size?: 'default' | 'wide';
  onclose: () => void;
  children: Snippet;
}

let { title, size = 'default', onclose, children }: Props = $props();

function onkeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') onclose();
}
</script>

<svelte:window {onkeydown} />

<div class="modal">
  <button class="back" type="button" aria-label="Close" onclick={onclose}></button>
  <div class="panel" class:wide={size === 'wide'} role="dialog" aria-modal="true" aria-label={title}>
    <div class="head">
      <h2>{title}</h2>
      <button class="icon-btn" type="button" aria-label="Close" onclick={onclose}>×</button>
    </div>
    {@render children()}
  </div>
</div>

<style>
  .modal {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 20px;
  }

  .back {
    position: absolute;
    inset: 0;
    appearance: none;
    border: 0;
    background: color-mix(in srgb, var(--ink) 32%, transparent);
    cursor: default;
  }

  .panel.wide {
    width: min(780px, 100%);
  }

  .panel {
    position: relative;
    width: min(560px, 100%);
    max-height: min(80vh, 100%);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
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
