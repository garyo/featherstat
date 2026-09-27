<script lang="ts">
/**
 * What a tab open across a deploy looks like from inside the page. Nothing here
 * can fix it — the build this page is running is gone from the server — so this
 * says so plainly and offers the only move there is. It never dismisses itself:
 * every code-split part of the app is dead until the reload.
 *
 * The named examples are examples, not the list: `lib/chunks.ts` decides what is
 * code-split, and a message that enumerates it goes stale the next time one is
 * added — which is how the detail views came to be missing from it.
 */
</script>

<div class="stale" role="alert">
  <span
    >featherstat has been updated. This page is still running the old version, so parts of it —
    Share, Edit, Settings, the detail views — can no longer open.</span
  >
  <button class="btn slim primary" type="button" onclick={() => location.reload()}>Reload</button>
</div>

<style>
  .stale {
    position: fixed;
    /* Above the page's own stacking. An open modal <dialog> is in the top layer
       and covers this (inert) until it closes — every chunk loads from a control
       outside a dialog, so only a history move can overlap the two. */
    z-index: 60;
    inset: auto 16px 16px;
    margin: 0 auto;
    max-width: 520px;
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    font-size: 13px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 18%);
  }
</style>
