<script lang="ts">
import BarRows from './BarRows.svelte';
import { brokenLinkBars } from './broken-links.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * Broken links (docs/04 § 3 `missing`): paths visitors asked for that do not
 * exist, each with the page that most often linked there. A frame around
 * `BarRows`, like time on page; rows inform rather than filter.
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const rows = $derived(slice.kind === 'ready' ? brokenLinkBars(slice.result.rows) : []);
</script>

<h2>{spec.title ?? spec.id}</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if rows.length === 0}
    <p class="widget-note">No requests for missing pages in this period.</p>
  {:else}
    <BarRows {rows} unit="hits" onfilter={null} />
  {/if}
</div>
