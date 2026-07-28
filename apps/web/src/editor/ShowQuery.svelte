<script lang="ts">
import { isQueryError, type WidgetSpec, widgetQueries } from '@analytics/shared';
import type { WidgetData } from '../widgets/types.ts';
import Modal from './Modal.svelte';

/**
 * "Show query" (docs/05 § Widgets): the JSON slice this widget contributed to
 * the view's one batch, keyed by result slot — the self-documenting API — plus
 * the server's per-query timing when the answer is on hand.
 */
interface Props {
  spec: WidgetSpec;
  data?: WidgetData;
  onclose: () => void;
}

let { spec, data, onclose }: Props = $props();

const queries = $derived(widgetQueries(spec));

const timings = $derived.by(() => {
  if (data === undefined || data.phase !== 'ready') return [];
  const lines: string[] = [];
  for (const slot of Object.keys(queries)) {
    const result = data.results[slot];
    if (result === undefined || isQueryError(result) || result.ms === undefined) continue;
    lines.push(`${slot}: ${result.ms.toFixed(1)} ms`);
  }
  return lines;
});
</script>

<Modal title="Query — {spec.title ?? spec.viz}" {onclose}>
  {#if Object.keys(queries).length === 0}
    <p class="widget-note">This widget declares no queries.</p>
  {:else}
    <pre class="query-json">{JSON.stringify(queries, null, 2)}</pre>
    {#if timings.length > 0}
      <p class="timing">Server time — {timings.join(' · ')}</p>
    {/if}
  {/if}
</Modal>

<style>
  .query-json {
    margin: 0;
    padding: 12px;
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
    overflow: auto;
    max-height: 60vh;
  }

  .timing {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
</style>
