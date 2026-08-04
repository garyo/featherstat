<script lang="ts">
import type { FilterNode } from '@featherstat/shared';
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
  /** Chips bound by the view itself (a detail view's entity) — visible so the
   * scope is never hidden, not removable because leaving IS removing them. */
  locked?: readonly string[];
  /** Active dimension filters, as removable chips (docs/05). */
  filters?: readonly FilterNode[];
  /** Names for the segment refs among them, so a chip reads as its segment. */
  segmentNames?: ReadonlyMap<number, string>;
  /** Muted trailing line — the resolved window and compare mode. */
  note?: string;
  onselect: (range: ViewRange) => void;
  oncompare?: (cmp: CompareChoice) => void;
  onremovefilter?: (index: number) => void;
  /** Opens the expression editor; omitted leaves the row chips-only. */
  oneditfilters?: () => void;
  /** Present after a failed batch: re-runs it even though the view state didn't change. */
  onretry?: () => void;
}

let {
  range,
  cmp,
  locked = [],
  filters = [],
  segmentNames,
  note,
  onselect,
  oncompare,
  onremovefilter,
  oneditfilters,
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
  {#each locked as label, i (i)}
    <span class="fchip locked" title="This view is about this — go back to remove it">
      <span aria-hidden="true">🔒</span>
      {label}
    </span>
  {/each}
  {#each filters as filter, i (i)}
    {@const label = chipLabel(filter, segmentNames)}
    <!-- An expression chip is far longer than a `Country: US` one, so the label
         is its own flex item: a bare text node cannot take `text-overflow`, and
         the whole expression is in `title` because the pill will truncate it. -->
    <button
      class="fchip"
      type="button"
      title="{label} — click to remove"
      aria-label="Remove filter {label}"
      onclick={() => onremovefilter?.(i)}
    >
      <span class="fchip-label">{label}</span><span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#if oneditfilters !== undefined}
    <button class="preset" type="button" onclick={oneditfilters}>
      {filters.length === 0 ? '+ Filter' : 'Edit filter'}
    </button>
  {/if}
  {#if note !== undefined}<span class="compare-note">{note}</span>{/if}
  {#if onretry !== undefined}<button class="retry" type="button" onclick={onretry}>Retry</button>{/if}
</div>

<style>
  /* A locked chip is a statement, not a control (docs/05 § Detail views). */
  .fchip.locked {
    cursor: default;
  }

  .fchip.locked:hover {
    border-color: color-mix(in srgb, var(--s1) 35%, transparent);
  }

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
