<script lang="ts">
import type { Dashboard, Filter, QueryResponse, SiteInfo, WidgetSpec } from '@featherstat/shared';
import type { ShowQuery } from '../editor/editor.ts';
import { loadEditor } from '../lib/editor-mode.svelte.ts';
import type { RangePreset } from '../lib/state.ts';
import { REGISTRY, spanClass } from '../widgets/registry.ts';
import { collectBatch, widgetData } from './batch.ts';

interface Props {
  dashboard: Dashboard;
  response: QueryResponse | undefined;
  /** Batch-level failure — widgets surface it when there is nothing older to show. */
  error: string | undefined;
  refetching: boolean;
  /** The requested site-local window, for charts to pad their series out to. */
  window?: { from: string; to: string };
  /** Range qualifier for widget titles ("last 30 days"). */
  rangeLabel?: string;
  range?: RangePreset;
  active?: Record<number, number>;
  sites?: ReadonlyMap<number, SiteInfo>;
  /** Per-widget admin chrome ("show query"); off on the read-only share page. */
  chrome?: boolean;
  onselectsite?: (site: number) => void;
  onfilter?: (filter: Filter) => void;
}

let {
  dashboard,
  response,
  error,
  refetching,
  window,
  rangeLabel,
  range,
  active,
  sites,
  chrome = true,
  onselectsite,
  onfilter,
}: Props = $props();

const slots = $derived(collectBatch(dashboard).slots);

// "Show query" chrome (docs/05: the self-documenting API). The button is view
// chrome; the modal itself lives in the code-split editor chunk and loads on
// first use — the view path ships zero editor code.
let ShowQueryModal = $state<typeof ShowQuery | undefined>(undefined);
let shownQuery = $state<WidgetSpec | undefined>(undefined);

async function showQuery(spec: WidgetSpec): Promise<void> {
  ShowQueryModal ??= (await loadEditor()).ShowQuery;
  shownQuery = spec;
}
</script>

<div class="grid" class:refetching>
  {#each dashboard.grid as spec (spec.id)}
    {@const entry = REGISTRY[spec.viz]}
    <div class={entry?.frame === 'wide' ? 'wide' : `card ${spanClass(spec.w)}`}>
      {#if chrome}
        <button
          class="q-btn"
          type="button"
          title="Show query"
          aria-label="Show query for {spec.title ?? spec.viz}"
          onclick={() => void showQuery(spec)}>&lbrace;&rbrace;</button
        >
      {/if}
      {#if entry === undefined}
        <h2>{spec.title ?? spec.viz}</h2>
        <p class="widget-note">The “{spec.viz}” widget isn’t available yet.</p>
      {:else}
        {@const Widget = entry.component}
        <Widget
          {spec}
          data={widgetData(spec, slots, response, error)}
          {window}
          {rangeLabel}
          {range}
          {active}
          {sites}
          {onselectsite}
          {onfilter}
        />
      {/if}
    </div>
  {/each}
</div>

{#if ShowQueryModal !== undefined && shownQuery !== undefined}
  <ShowQueryModal
    spec={shownQuery}
    data={widgetData(shownQuery, slots, response, error)}
    onclose={() => (shownQuery = undefined)}
  />
{/if}

<style>
  /* The refetch hold (docs/05): previous render stays, dimmed — never a skeleton. */
  .grid {
    transition: opacity 0.15s linear;
  }

  .grid.refetching {
    opacity: 0.6;
  }

  .wide {
    grid-column: 1 / -1;
    min-width: 0;
  }

  /* Anchor the per-widget chrome without disturbing the card grammar. */
  .card,
  .wide {
    position: relative;
  }

  .q-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s linear;
  }

  :is(.card, .wide):hover .q-btn,
  .q-btn:focus-visible {
    opacity: 1;
  }

  .q-btn:hover {
    color: var(--ink);
  }
</style>
