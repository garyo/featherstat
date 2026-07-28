<script lang="ts">
import { dwellRows } from './dwell.ts';
import { compactNumber, exactNumber, formatDuration } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * Time on page (docs/04 § 3 `dwell`): pages ranked by average measured dwell,
 * each behind a wash bar, with the max and the number of measured views
 * alongside — the card says what its average rests on, because views nothing
 * followed are excluded rather than counted as zero.
 *
 * Rows are deliberately NOT click-to-filter: the query is session-scoped and
 * cannot honestly take a `path` filter, so a click would break the card.
 */
let { spec, data }: WidgetProps = $props();

const slice = $derived(sliceOf(data, 'main'));
const rows = $derived(slice.kind === 'ready' ? dwellRows(slice.result.rows) : []);
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
    <div class="bar-list">
      {#each rows as row (row.path)}
        <div
          class="bar-row"
          title="{exactNumber(Math.round(row.avgMs))} ms average · {exactNumber(
            Math.round(row.maxMs),
          )} ms longest · {exactNumber(row.views)} measured views"
        >
          <span class="bar" style="width: {row.pct}%"></span>
          <span class="name">{row.path}</span>
          <span class="num">{formatDuration(row.avgMs)}</span>
          <span class="num dwell-sub"
            >max {formatDuration(row.maxMs)} · {compactNumber(row.views)} measured</span
          >
        </div>
      {/each}
    </div>
  {/if}
</div>
