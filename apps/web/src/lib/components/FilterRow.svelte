<script lang="ts">
import type { Filter } from '@featherstat/shared';
import { chipLabel } from '../filters.ts';
import {
  type CompareChoice,
  type CustomRange,
  formatDayRange,
  RANGE_LABELS,
  RANGE_PRESETS,
  type RangePreset,
  type ViewRange,
} from '../state.ts';

interface Props {
  range: ViewRange;
  /** Compare mode; omitted hides the compare control (Journeys sends no compare). */
  cmp?: CompareChoice;
  /** Active dimension filters, as removable chips (docs/05). */
  filters?: readonly Filter[];
  /** Muted trailing line — the resolved window and compare mode. */
  note?: string;
  onselect: (range: ViewRange) => void;
  oncompare?: (cmp: CompareChoice) => void;
  onremovefilter?: (index: number) => void;
  /** Present after a failed batch: re-runs it even though the view state didn't change. */
  onretry?: () => void;
}

let {
  range,
  cmp,
  filters = [],
  note,
  onselect,
  oncompare,
  onremovefilter,
  onretry,
}: Props = $props();

// --- Custom range: two native date inputs behind one pill (no picker library —
// the bundle ratchet is the design constraint here, docs/05).
let editing = $state(false);
let from = $state('');
let to = $state('');
const custom = $derived(typeof range !== 'string');

function openEditor(): void {
  editing = !editing;
  if (editing && typeof range !== 'string') {
    from = range.from;
    to = range.to;
  }
}

const valid = $derived(from !== '' && to !== '' && from <= to);

function apply(): void {
  if (!valid) return;
  editing = false;
  onselect({ from, to });
}

function selectPreset(preset: RangePreset): void {
  editing = false;
  onselect(preset);
}

// --- Compare: previous / last year / off / an explicit window.
let cmpFrom = $state('');
let cmpTo = $state('');
/** True while "custom…" is picked but its dates are not applied yet. */
let cmpEditing = $state(false);
const cmpValue = $derived(
  cmpEditing ? 'custom' : typeof cmp === 'string' ? cmp : cmp === undefined ? 'previous' : 'custom',
);
const cmpValid = $derived(cmpFrom !== '' && cmpTo !== '' && cmpFrom <= cmpTo);

function onCompareChange(event: Event): void {
  const raw = (event.currentTarget as HTMLSelectElement).value;
  if (raw === 'previous' || raw === 'year' || raw === 'off') {
    cmpEditing = false;
    oncompare?.(raw);
    return;
  }
  cmpEditing = true;
  if (cmp !== undefined && typeof cmp !== 'string') {
    cmpFrom = cmp.from;
    cmpTo = cmp.to;
  }
}

function applyCompare(): void {
  if (!cmpValid) return;
  cmpEditing = false;
  oncompare?.({ from: cmpFrom, to: cmpTo });
}

const customCmp = $derived(cmp !== undefined && typeof cmp !== 'string');
</script>

<div class="filters" role="group" aria-label="Date range and filters">
  {#each RANGE_PRESETS as preset (preset)}
    <button
      class="preset"
      type="button"
      aria-pressed={range === preset}
      onclick={() => selectPreset(preset)}>{RANGE_LABELS[preset]}</button
    >
  {/each}
  <button
    class="preset"
    type="button"
    aria-pressed={custom}
    aria-expanded={editing}
    onclick={openEditor}>{custom ? formatDayRange(range as CustomRange) : 'Custom…'}</button
  >
  {#if editing}
    <span class="range-edit">
      <input type="date" aria-label="From date" bind:value={from} max={to === '' ? undefined : to} />
      <input type="date" aria-label="To date" bind:value={to} min={from === '' ? undefined : from} />
      <button class="preset" type="button" disabled={!valid} onclick={apply}>Apply</button>
    </span>
  {/if}
  {#if oncompare !== undefined}
    <select class="preset cmp" aria-label="Compare" value={cmpValue} onchange={onCompareChange}>
      <option value="previous">vs previous</option>
      <option value="year">vs last year</option>
      <option value="off">no compare</option>
      <option value="custom"
        >{customCmp && !cmpEditing ? `vs ${formatDayRange(cmp as CustomRange)}` : 'vs custom…'}</option
      >
    </select>
    {#if cmpEditing}
      <span class="range-edit">
        <input
          type="date"
          aria-label="Compare from date"
          bind:value={cmpFrom}
          max={cmpTo === '' ? undefined : cmpTo}
        />
        <input
          type="date"
          aria-label="Compare to date"
          bind:value={cmpTo}
          min={cmpFrom === '' ? undefined : cmpFrom}
        />
        <button class="preset" type="button" disabled={!cmpValid} onclick={applyCompare}
          >Apply</button
        >
      </span>
    {/if}
  {/if}
  {#each filters as filter, i (i)}
    {@const label = chipLabel(filter)}
    <button
      class="fchip"
      type="button"
      title="Remove filter"
      aria-label="Remove filter {label}"
      onclick={() => onremovefilter?.(i)}
    >
      {label}<span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#if note !== undefined}<span class="compare-note">{note}</span>{/if}
  {#if onretry !== undefined}<button class="retry" type="button" onclick={onretry}>Retry</button>{/if}
</div>

<style>
  .range-edit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .range-edit input[type='date'] {
    font: inherit;
    font-size: 12px;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }
</style>
