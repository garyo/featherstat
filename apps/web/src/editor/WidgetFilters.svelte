<script lang="ts">
import type { FilterLeaf, FilterNode, MetricQuery, WidgetSpec } from '@featherstat/shared';

/**
 * Per-widget filters (docs/05 § Widget filters): flat leaf rows over the
 * shared vocabulary, merged AND with the view's chips by the compiler — a
 * contradiction renders honestly empty with both chip sets visible. The UI
 * offers eq/neq/contains (the schema accepts more; a stored leaf with a rarer
 * op keeps it until this row's op is touched). Tree nodes (all/any/not/
 * segment) pass through untouched — the JSON editor owns those.
 *
 * Its own lazy chunk, deliberately importing only types beyond the runtime:
 * the dimension vocabulary arrives as a prop from WidgetSettings, so this
 * chunk shares no module with the entry and cannot fragment the first-load
 * chunk graph (which is measured whole — build.guard.ts).
 */
interface Props {
  spec: WidgetSpec;
  query: MetricQuery;
  /** The filterable dimensions, labeled — the caller reads the shared enum. */
  dims: readonly { value: string; label: string }[];
  onchange: (spec: WidgetSpec) => void;
}

let { spec, query, dims, onchange }: Props = $props();

const OP_WORDS = { eq: 'is', neq: 'is not', contains: 'contains' } as const;

function isLeaf(node: FilterNode): node is FilterLeaf {
  return 'dim' in node;
}

const leaves = $derived((query.filters ?? []).filter(isLeaf));

function commit(next: FilterLeaf[]): void {
  const trees = (query.filters ?? []).filter((node) => !isLeaf(node));
  const filters = [...trees, ...next];
  const { filters: _, ...rest } = query;
  onchange({
    ...spec,
    query: (filters.length === 0 ? rest : { ...rest, filters }) as MetricQuery,
  });
}

function setLeaf(index: number, patch: Partial<FilterLeaf>): void {
  commit(leaves.map((leaf, i) => (i === index ? { ...leaf, ...patch } : leaf)));
}
</script>

<fieldset class="wfilters">
  <legend>Only count rows where</legend>
  {#each leaves as leaf, i (i)}
    <div class="frow">
      <select
        aria-label="Filter dimension"
        value={leaf.dim}
        onchange={(event) => setLeaf(i, { dim: event.currentTarget.value as FilterLeaf['dim'] })}
      >
        {#each dims as dim (dim.value)}
          <option value={dim.value}>{dim.label}</option>
        {/each}
      </select>
      <select
        aria-label="Filter operator"
        value={leaf.op}
        onchange={(event) => setLeaf(i, { op: event.currentTarget.value as FilterLeaf['op'] })}
      >
        {#each Object.entries(OP_WORDS) as [op, word] (op)}
          <option value={op}>{word}</option>
        {/each}
      </select>
      <input
        type="text"
        aria-label="Filter value"
        value={typeof leaf.value === 'string' ? leaf.value : (leaf.value ?? []).join(', ')}
        onchange={(event) => setLeaf(i, { value: event.currentTarget.value })}
      />
      <button
        class="btn slim"
        type="button"
        aria-label="Remove this filter"
        onclick={() => commit(leaves.filter((_, at) => at !== i))}>×</button
      >
    </div>
  {/each}
  <button
    class="btn slim"
    type="button"
    onclick={() => commit([...leaves, { dim: 'path', op: 'eq', value: '' }])}>+ Add filter</button
  >
</fieldset>

<style>
  .wfilters {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }

  .wfilters legend {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
    padding: 0 4px;
  }

  .frow {
    display: flex;
    gap: 6px;
    width: 100%;
  }

  .frow input {
    flex: 1;
    min-width: 0;
  }
</style>
