<script lang="ts">
import BarRows from './BarRows.svelte';
import { dwellBars, dwellRows } from './dwell.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * Time on page (docs/04 § 3 `dwell`): pages ranked by median measured dwell,
 * each behind a wash bar, with the average, the max and the number of measured
 * views alongside — the card says what its numbers rest on, because views nothing
 * followed are excluded rather than counted as zero.
 *
 * The rows are `BarRows`, the same component every other ranking renders; this
 * card is a frame around it. Rows are deliberately NOT click-to-filter: the
 * query is session-scoped and cannot honestly take a `path` filter.
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const rows = $derived(slice.kind === 'ready' ? dwellBars(dwellRows(slice.result.rows)) : []);
</script>

<h2>{spec.title ?? spec.id}</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if rows.length === 0}
    <p class="widget-note">
      No measured views — pages need a heartbeat or a next click to be timed.
    </p>
  {:else}
    <BarRows {rows} unit="median" onfilter={null} />
  {/if}
</div>
