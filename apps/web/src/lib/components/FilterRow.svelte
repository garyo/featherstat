<script lang="ts">
import { RANGE_LABELS, RANGE_PRESETS, type RangePreset } from '../state.ts';

interface Props {
  range: RangePreset;
  /** Muted trailing line — the resolved window and compare mode. */
  note?: string;
  onselect: (range: RangePreset) => void;
  /** Present after a failed batch: re-runs it even though the view state didn't change. */
  onretry?: () => void;
}

let { range, note, onselect, onretry }: Props = $props();
</script>

<div class="filters" role="group" aria-label="Date range">
  {#each RANGE_PRESETS as preset (preset)}
    <button
      class="preset"
      type="button"
      aria-pressed={range === preset}
      onclick={() => onselect(preset)}>{RANGE_LABELS[preset]}</button
    >
  {/each}
  {#if note !== undefined}<span class="compare-note">{note}</span>{/if}
  {#if onretry !== undefined}<button class="retry" type="button" onclick={onretry}>Retry</button>{/if}
</div>
