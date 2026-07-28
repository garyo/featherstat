<script lang="ts">
import type { Filter } from '@featherstat/shared';
import { chipLabel } from '../filters.ts';
import { RANGE_LABELS, RANGE_PRESETS, type RangePreset } from '../state.ts';

interface Props {
  range: RangePreset;
  /** Active dimension filters, as removable chips (docs/05). */
  filters?: readonly Filter[];
  /** Muted trailing line — the resolved window and compare mode. */
  note?: string;
  onselect: (range: RangePreset) => void;
  onremovefilter?: (index: number) => void;
  /** Present after a failed batch: re-runs it even though the view state didn't change. */
  onretry?: () => void;
}

let { range, filters = [], note, onselect, onremovefilter, onretry }: Props = $props();
</script>

<div class="filters" role="group" aria-label="Date range and filters">
  {#each RANGE_PRESETS as preset (preset)}
    <button
      class="preset"
      type="button"
      aria-pressed={range === preset}
      onclick={() => onselect(preset)}>{RANGE_LABELS[preset]}</button
    >
  {/each}
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
