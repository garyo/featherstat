<script lang="ts">
import type { Dashboard, QueryResponse, WidgetSpec } from '@featherstat/shared';
import type { ShowQuery } from '../editor/editor.ts';
import { loadEditor } from '../lib/editor-mode.svelte.ts';
import { gridEnv } from '../widgets/env.ts';
import type { ViewEnv } from '../widgets/types.ts';
import WidgetGrid from '../widgets/WidgetGrid.svelte';
import { collectBatch, widgetData } from './batch.ts';

/**
 * The view path's dashboard: it routes the one batch's answers to the widgets
 * and decorates `WidgetGrid` (which owns the rendering) with the per-widget
 * "show query" chrome.
 */
interface Props {
  dashboard: Dashboard;
  response: QueryResponse | undefined;
  /** Batch-level failure — widgets surface it when there is nothing older to show. */
  error: string | undefined;
  refetching: boolean;
  /** What the widgets render from; the windows come from the response above. */
  env: ViewEnv;
  /** Per-widget admin chrome ("show query"); off on the read-only share page. */
  chrome?: boolean;
}

let { dashboard, response, error, refetching, env, chrome = true }: Props = $props();

const slots = $derived(collectBatch(dashboard).slots);
// The windows come straight off the response, so the axes a widget draws always
// belong to the answer beside them — the view has nothing to pass and nothing
// to get wrong.
const widgetsEnv = $derived(gridEnv(env, response));

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

<WidgetGrid
  grid={dashboard.grid}
  dataFor={(spec) => widgetData(spec, slots, response, error)}
  {refetching}
  env={widgetsEnv}
>
  {#snippet card({ spec, frame, widget })}
    <div class={frame}>
      {#if chrome}
        <button
          class="q-btn"
          type="button"
          title="Show query"
          aria-label="Show query for {spec.title ?? spec.viz}"
          onclick={() => void showQuery(spec)}>&lbrace;&rbrace;</button
        >
      {/if}
      {@render widget()}
    </div>
  {/snippet}
</WidgetGrid>

{#if ShowQueryModal !== undefined && shownQuery !== undefined}
  <ShowQueryModal
    spec={shownQuery}
    data={widgetData(shownQuery, slots, response, error)}
    onclose={() => (shownQuery = undefined)}
  />
{/if}

<style>
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
