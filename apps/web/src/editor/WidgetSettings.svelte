<script lang="ts">
import type { WidgetSpec } from '@analytics/shared';
import { type SiteSort, siteSortOf } from '../widgets/site-stats.ts';
import Modal from './Modal.svelte';

/**
 * Per-widget options (docs/05 edit mode). Every change commits to the draft
 * immediately — the grid card re-renders in place, and query-shaping changes
 * (the bar-list limit) get a batch-of-one preview from the Editor.
 */
interface Props {
  spec: WidgetSpec;
  onchange: (spec: WidgetSpec) => void;
  onclose: () => void;
}

let { spec, onchange, onclose }: Props = $props();

const metricQuery = $derived(
  spec.query !== undefined && !('kind' in spec.query) ? spec.query : undefined,
);
/** The bar-list row-count option; other list-shaped vizzes share it. */
const hasLimit = $derived(spec.viz === 'bar-list' && metricQuery !== undefined);

const SORTS: { value: SiteSort; label: string }[] = [
  { value: 'traffic', label: 'Traffic (busiest first)' },
  { value: 'id', label: 'Site id' },
  { value: 'name', label: 'Name' },
];

function setTitle(title: string): void {
  const trimmed = title.trim();
  const { title: _, ...rest } = spec;
  onchange(trimmed === '' ? rest : { ...rest, title: trimmed });
}

/** Commits on change (blur/Enter), not per keystroke: mid-edit values like the
 * "2" of "25" must neither clamp under the cursor nor fire preview queries. */
function setLimit(input: HTMLInputElement): void {
  if (metricQuery === undefined) return;
  const parsed = Math.round(Number(input.value));
  const limit = Number.isFinite(parsed)
    ? Math.min(1000, Math.max(1, parsed))
    : (metricQuery.limit ?? 8);
  input.value = String(limit);
  if (limit !== metricQuery.limit) onchange({ ...spec, query: { ...metricQuery, limit } });
}

function setSort(sort: string): void {
  onchange({ ...spec, options: { ...spec.options, sort: siteSortOf(sort) } });
}
</script>

<Modal title="Widget settings — {spec.title ?? spec.viz}" {onclose}>
  <div class="form">
    <label class="field">
      Title
      <input
        type="text"
        value={spec.title ?? ''}
        placeholder={spec.viz}
        maxlength="200"
        oninput={(event) => setTitle(event.currentTarget.value)}
      />
    </label>
    {#if hasLimit}
      <label class="field">
        Rows
        <input
          type="number"
          value={metricQuery?.limit ?? 8}
          min="1"
          max="1000"
          step="1"
          onchange={(event) => setLimit(event.currentTarget)}
        />
      </label>
    {/if}
    {#if spec.viz === 'site-cards'}
      <label class="field">
        Sort order
        <select value={siteSortOf(spec.options.sort)} onchange={(event) => setSort(event.currentTarget.value)}>
          {#each SORTS as sort (sort.value)}
            <option value={sort.value}>{sort.label}</option>
          {/each}
        </select>
      </label>
    {/if}
    <div class="actions">
      <button class="btn primary" type="button" onclick={onclose}>Done</button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
</style>
