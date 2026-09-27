<script lang="ts">
import DataTable from './DataTable.svelte';
import { exactNumber } from './format.ts';
import { histogramBars } from './histogram.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * Fixed-bucket histogram over a `distribution` result (docs/04 § 3): dwell
 * duration bands or scroll-depth deciles, drawn as plain columns. Only
 * MEASURED legs are counted server-side, so an empty card means "nothing was
 * measured", never "nobody scrolled".
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const of = $derived(
  spec.query !== undefined && 'kind' in spec.query && spec.query.kind === 'distribution'
    ? spec.query.of
    : undefined,
);
const bars = $derived(
  slice.kind === 'ready' && of !== undefined ? histogramBars(slice.result.rows, of) : [],
);
const empty = $derived(bars.every((bar) => bar.value === 0));
</script>

<h2>{spec.title ?? spec.id}</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if of === undefined}
    <p class="widget-note">This widget needs a distribution query.</p>
  {:else if empty}
    <p class="widget-note">No measured views in this range.</p>
  {:else}
    <div class="hist">
      {#each bars as bar (bar.label)}
        <div class="hcol" title="{bar.label}: {exactNumber(bar.value)} views">
          <div class="hwell">
            <div class="hbar" style="height: {Math.max(bar.pct, 1)}%"></div>
          </div>
          <span class="hlab">{bar.label}</span>
        </div>
      {/each}
    </div>
    <DataTable
      caption="{spec.title ?? spec.id} — measured views per band"
      head={['Band', 'Views']}
      rows={bars.map((bar) => ({ key: bar.label, label: bar.label, cells: [exactNumber(bar.value)] }))}
    />
  {/if}
</div>

<style>
  /* A definite height, so the percentage bars have something to be a percent OF. */
  .hist {
    display: flex;
    align-items: stretch;
    gap: 6px;
    height: 150px;
    padding-top: 8px;
  }

  .hcol {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* The bar's percentage height resolves against this flex-sized track. */
  .hwell {
    flex: 1;
    display: flex;
    align-items: flex-end;
  }

  .hbar {
    width: 100%;
    background: color-mix(in srgb, var(--s1) 70%, transparent);
    border-radius: 3px 3px 0 0;
  }

  .hlab {
    font-size: 10px;
    color: var(--muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
