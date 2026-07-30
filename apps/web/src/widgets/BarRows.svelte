<script lang="ts">
import type { Dimension, Filter } from '@featherstat/shared';
import type { BarRow } from './bar-rows.ts';
import { compactNumber, exactNumber } from './format.ts';
import { countryName, flagEmoji } from './geo.ts';

/**
 * The ranked rows of a bar-list — shared between the standalone bar-list card
 * and composites like the devices card. Rows are click-to-filter when a
 * dimension and handler are wired (docs/05: every breakdown row filters), and
 * every row is keyboard-reachable with a focus/hover tooltip for exact values.
 * All labels are visitor-controlled strings: text interpolation only.
 */
interface Props {
  rows: readonly BarRow[];
  /** Tooltip unit for the primary value (`visitors`, `events`, …). */
  unit: string;
  /** Tooltip unit for `extra` when a row carries one (`value`). */
  extraUnit?: string;
  /** Row names are ISO country codes: prepend the flag, display the region name. */
  flags?: boolean;
  /** The dimension rows filter on; omitted, rows are informational only. */
  dim?: Dimension;
  /** Click-to-filter, or null where a row has nothing to filter into. */
  onfilter: ((filter: Filter) => void) | null;
}

let { rows, unit, extraUnit = 'value', flags = false, dim, onfilter }: Props = $props();

const filterable = $derived(dim !== undefined && onfilter !== null);

function activate(row: BarRow): void {
  if (dim === undefined || onfilter === null || row.filterValue === undefined) return;
  onfilter(
    row.filterValue === null ? { dim, op: 'is_null' } : { dim, op: 'eq', value: row.filterValue },
  );
}

function onKeydown(event: KeyboardEvent, row: BarRow): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate(row);
  }
}

/** docs/05: per-mark tooltips from the same designed hover layer as the charts'. */
let tip = $state<{ index: number; x: number; y: number; below: boolean } | undefined>();
let pane: HTMLDivElement | undefined = $state();

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/** Above this offset there is no room over the row — flip under it (like Timeseries). */
const FLIP_BELOW_PX = 44;

function showTip(row: HTMLElement, index: number, clientX?: number): void {
  if (pane === undefined) return;
  const rect = pane.getBoundingClientRect();
  // Pointer-led when hovering, centered when reached by keyboard focus.
  const x =
    clientX === undefined ? rect.width / 2 : clamp(clientX - rect.left, 40, rect.width - 40);
  const below = row.offsetTop < FLIP_BELOW_PX;
  tip = {
    index,
    x,
    y: below ? row.offsetTop + row.offsetHeight + 6 : row.offsetTop - 6,
    below,
  };
}

const tipRow = $derived(tip === undefined ? undefined : rows[tip.index]);
</script>

<div class="rows-pane" bind:this={pane}>
  <div class="bar-list">
    {#each rows as row, i (row.name)}
      {@const clickable = filterable && row.filterValue !== undefined}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions --
           docs/05 accessibility: every mark keyboard-reachable with a focus/hover
           tooltip; rows with a filter target additionally act as buttons -->
      <div
        class="bar-row"
        class:clickable
        role={clickable ? 'button' : undefined}
        tabindex="0"
        onclick={clickable ? () => activate(row) : undefined}
        onkeydown={clickable ? (event) => onKeydown(event, row) : undefined}
        onpointermove={(event) => showTip(event.currentTarget, i, event.clientX)}
        onpointerleave={() => (tip = undefined)}
        onfocus={(event) => showTip(event.currentTarget, i)}
        onblur={() => (tip = undefined)}
      >
        <span class="bar" style="width: {row.pct}%"></span>
        <span class="name">
          {#if flags && typeof row.filterValue === 'string'}
            {@const flag = flagEmoji(row.filterValue)}
            {#if flag !== undefined}<span class="flag">{flag}</span>{/if}
            {countryName(row.filterValue)}
          {:else}
            {row.name}
          {/if}
        </span>
        <!-- Count only: a second unlabeled number breaks the tabular column and
             reads as a glitch; the value sum lives in the tooltip, labeled. -->
        <span class="num">{compactNumber(row.value)}</span>
      </div>
    {/each}
  </div>
  {#if tip !== undefined && tipRow !== undefined}
    <div
      class="chart-tip"
      style="left: {tip.x}px; top: {tip.y}px; transform: translate(-50%, {tip.below
        ? '0'
        : '-100%'});"
    >
      <div class="tip-row">
        <span class="tip-val">{exactNumber(tipRow.value)}</span>
        <span class="tip-name">{unit}</span>
      </div>
      {#if tipRow.extra > 0}
        <div class="tip-row">
          <span class="tip-val">{exactNumber(tipRow.extra)}</span>
          <span class="tip-name">{extraUnit}</span>
        </div>
      {/if}
      <!-- A shortened label (an outbound URL's protocol) says its whole value here. -->
      {#if tipRow.full !== undefined}
        <div class="tip-full">{tipRow.full}</div>
      {/if}
    </div>
  {/if}
</div>
