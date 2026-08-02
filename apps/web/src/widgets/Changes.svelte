<script lang="ts">
import { changeSections } from './changes.ts';
import { compactNumber, exactNumber } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * The `changes` viz (docs/05 § What changed): the server's top movers between
 * the compare windows, as a compact signed-bar list — value and current count
 * in one column, the delta bar with its share of the net change in the other,
 * one section per scanned dimension. Rise and fall wear the theme's status
 * colors WITH a sign glyph, so color never carries the direction alone. When
 * the view's compare is off, the server's refusal renders like any other
 * per-query error entry.
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const sections = $derived(slice.kind === 'ready' ? changeSections(slice.result.rows) : []);

/** Exact numbers and the row's share of the net move live in the tooltip. */
function rowTip(row: (typeof sections)[number]['rows'][number]): string {
  const to = `${exactNumber(row.current - row.delta)} → ${exactNumber(row.current)}`;
  return row.share === '' ? to : `${to} — ${row.share} of the change`;
}
</script>

<h2>{spec.title ?? 'What changed'}</h2>
<div class="list-pane">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if sections.length === 0}
    <p class="widget-note">Nothing moved between the two periods.</p>
  {:else}
    <div class="chg-grid">
      {#each sections as section (section.dim)}
        <div class="chg-col">
          <h3 class="chg-dim">{section.label}</h3>
          {#each section.rows as row (row.name)}
            <div class="chg-row" title={rowTip(row)}>
              <span class="chg-name">{row.name}</span>
              <span class="num">{compactNumber(row.current)}</span>
              <span class="chg-bar" class:down={row.delta < 0}>
                <span style="width: {row.pct}%"></span>
              </span>
              <span class="chg-delta" class:down={row.delta < 0}>
                {row.delta > 0 ? '+' : '−'}{compactNumber(Math.abs(row.delta))}
              </span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 4px 20px;
    align-content: start;
  }

  .chg-dim {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 6px 0 2px;
  }

  .chg-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 13px;
  }

  .chg-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chg-bar {
    width: 56px;
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    overflow: hidden;
    display: inline-flex;
  }

  .chg-bar > span {
    background: var(--good);
    border-radius: 3px;
  }

  .chg-bar.down > span {
    background: var(--bad);
  }

  .chg-delta {
    min-width: 52px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--good);
  }

  .chg-delta.down {
    color: var(--bad);
  }
</style>
