<script lang="ts">
import { TALLY_WINDOW_LABEL } from '@featherstat/shared';
import { countryRows, countryTally, scopedHits } from '../lib/realtime.ts';
import BarRows from './BarRows.svelte';
import type { WidgetProps } from './types.ts';

/** Where the last half hour came from — the shared bar rows, fed by the stream. */
let { spec, env }: WidgetProps = $props();

const rows = $derived(countryRows(countryTally(scopedHits(env.realtime, env.scope), env.now)));
</script>

<h2>{spec.title ?? `Countries · ${TALLY_WINDOW_LABEL}`}</h2>
{#if rows.length === 0}
  <p class="widget-note">No located visitors in the {TALLY_WINDOW_LABEL}.</p>
{:else}
  <!-- Realtime is stream-shaped, not query-shaped: there is nothing to filter into. -->
  <BarRows {rows} unit="visitors" flags onfilter={null} />
{/if}
