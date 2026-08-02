<script lang="ts">
import { BaseDimensionSchema } from '@featherstat/shared';
import { emptyRow, type FilterRow, ROW_OPS } from '../../lib/filter-builder.ts';

/**
 * The filter editor segments and goals share (docs/05 § Settings): rows of
 * dim/op/value that AND together, with an "advanced" JSON textarea for the
 * trees rows cannot say (any/not, session scope). The parent owns validation
 * and the wire shape — this component only edits the two drafts; which one
 * counts is `advanced`, and the parent converts on toggle so nothing edited
 * here is ever silently dropped.
 */
interface Props {
  rows: FilterRow[];
  json: string;
  advanced: boolean;
  /** The parent's refusal for the current draft, shown under the editor. */
  error: string | undefined;
  /** Rows → JSON always works; JSON → rows may refuse (the parent knows how). */
  ontoggle: () => void;
}

let {
  rows = $bindable(),
  json = $bindable(),
  advanced = $bindable(),
  error,
  ontoggle,
}: Props = $props();

const dims = BaseDimensionSchema.options;
</script>

{#if advanced}
  <textarea
    class="filter-json"
    rows="6"
    bind:value={json}
    spellcheck="false"
    aria-label="Filter tree as JSON"
  ></textarea>
  <p class="widget-note">
    The full grammar: a leaf, or <code>&#123;"all"/"any"/"not": …&#125;</code> over subtrees; a leaf
    may add <code>"scope": "session"</code>.
  </p>
{:else}
  {#each rows as row, index (index)}
    <div class="frow">
      <span class="field fdim">
        <input bind:value={row.dim} list="filter-dims" aria-label="Dimension {index + 1}" />
      </span>
      <span class="field">
        <select bind:value={row.op} aria-label="Operator {index + 1}">
          {#each ROW_OPS as { op, label } (op)}<option value={op}>{label}</option>{/each}
        </select>
      </span>
      {#if row.op !== 'is_null'}
        <span class="field fval">
          <input
            bind:value={row.value}
            placeholder={row.op === 'in' ? 'a, b, c' : 'value'}
            aria-label="Value {index + 1}"
          />
        </span>
      {/if}
      <button
        class="btn subtle"
        type="button"
        aria-label="Remove condition {index + 1}"
        onclick={() => (rows = rows.filter((_, i) => i !== index))}>×</button
      >
    </div>
  {/each}
  <datalist id="filter-dims">
    {#each dims as dim (dim)}<option value={dim}></option>{/each}
  </datalist>
{/if}
{#if error !== undefined}<p class="form-error" role="alert">{error}</p>{/if}
<div class="frow">
  {#if !advanced}
    <button class="btn" type="button" onclick={() => (rows = [...rows, emptyRow()])}>
      Add condition (and)
    </button>
  {/if}
  <button class="btn subtle" type="button" onclick={ontoggle}>
    {advanced ? 'Back to simple rows' : 'Edit as JSON'}
  </button>
</div>

<style>
  .frow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .fdim {
    flex: 0 1 150px;
    min-width: 0;
  }

  .fval {
    flex: 1 1 140px;
    min-width: 0;
  }

  .filter-json {
    width: 100%;
    font: 11.5px/1.5 ui-monospace, monospace;
    color: var(--ink);
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px 10px;
    resize: vertical;
  }
</style>
