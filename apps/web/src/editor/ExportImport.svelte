<script lang="ts">
import type { Dashboard } from '@featherstat/shared';
import Modal from './Modal.svelte';
import { exportJson, parseDashboardJson } from './model.ts';

/**
 * Export/import = copy the JSON (docs/05 § Widgets). The textarea starts as the
 * draft's export; Apply parses it back through DashboardSchema and reports
 * readable `path: message` errors instead of applying half a document.
 */
interface Props {
  draft: Dashboard;
  onapply: (dashboard: Dashboard) => void;
  onclose: () => void;
}

let { draft, onapply, onclose }: Props = $props();

// A snapshot at open is the point: applying re-opens from the applied draft.
// svelte-ignore state_referenced_locally
let text = $state(exportJson(draft));
let errors = $state<string[]>([]);

function apply(): void {
  const parsed = parseDashboardJson(text);
  if (parsed.ok) {
    errors = [];
    onapply(parsed.dashboard);
  } else {
    errors = parsed.errors;
  }
}
</script>

<Modal title="Export / import JSON" {onclose}>
  <div class="form">
    <p class="hint">
      This dashboard as JSON — copy it out, or paste a dashboard in and apply it to the draft.
    </p>
    <textarea bind:value={text} rows="16" spellcheck="false" aria-label="Dashboard JSON"
    ></textarea>
    {#if errors.length > 0}
      <ul class="errors">
        {#each errors as message (message)}
          <li class="form-error">{message}</li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onclose}>Close</button>
      <button class="btn primary" type="button" onclick={apply}>Apply to draft</button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12.5px;
  }

  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    resize: vertical;
    min-height: 200px;
  }

  textarea:focus-visible {
    outline: 2px solid var(--s1);
    outline-offset: 1px;
  }

  .errors {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
