<script lang="ts">
import { changeSections } from './changes.ts';
import { compactNumber, exactNumber } from './format.ts';
import { sliceOf, type WidgetProps } from './types.ts';

/**
 * The `changes` viz (docs/05 § Biggest changes): the server's top movers
 * between the compare windows, one section per scanned dimension. Each row
 * writes both windows' counts (`3 → 0`) so no lone number reads as the range's
 * total, and its bar is the signed move on a track centered on zero — a fall
 * grows left, a rise right. Rise and fall wear the theme's status colors WITH a
 * sign glyph, so color never carries the direction alone. When the view's
 * compare is off, the server's refusal renders like any other per-query error
 * entry.
 */
let { spec, env }: WidgetProps = $props();

const slice = $derived(sliceOf(env.data, 'main'));
const sections = $derived(slice.kind === 'ready' ? changeSections(slice.result.rows) : []);

/** The untruncated name, exact numbers and the share of the net move live in the tooltip. */
function rowTip(row: (typeof sections)[number]['rows'][number]): string {
  const to = `${row.name}: ${exactNumber(row.previous)} → ${exactNumber(row.current)}`;
  return row.share === '' ? to : `${to} — ${row.share} of the change`;
}
</script>

<h2>{spec.title ?? 'Biggest changes'}</h2>
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
              <span class="num chg-counts">
                {compactNumber(row.previous)} → {compactNumber(row.current)}
              </span>
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
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
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

  .chg-counts {
    color: var(--muted);
    white-space: nowrap;
  }

  /* Centered on zero: the rule in the middle is "no change". */
  .chg-bar {
    position: relative;
    flex-shrink: 0;
    width: 72px;
    height: 6px;
    border-radius: 3px;
    background:
      linear-gradient(var(--muted), var(--muted)) center / 1px 10px no-repeat,
      color-mix(in srgb, var(--ink) 7%, transparent);
  }

  .chg-bar > span {
    position: absolute;
    inset-block: 0;
    left: 50%;
    background: var(--good);
    border-radius: 0 3px 3px 0;
  }

  .chg-bar.down > span {
    left: auto;
    right: 50%;
    background: var(--bad);
    border-radius: 3px 0 0 3px;
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
