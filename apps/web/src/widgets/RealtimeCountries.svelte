<script lang="ts">
import { countryRows, countryTally, scopedHits } from '../lib/realtime.ts';
import BarRows from './BarRows.svelte';
import type { WidgetProps } from './types.ts';

/** Where the last half hour came from — the shared bar rows, fed by the stream. */
let { spec, env }: WidgetProps = $props();

const rows = $derived(countryRows(countryTally(scopedHits(env.realtime, env.scope), env.now)));
</script>

<h2>{spec.title ?? 'Countries · last 30 min'}</h2>
{#if rows.length === 0}
  <p class="widget-note">No located visitors in the last 30 minutes.</p>
{:else}
  <!-- Realtime is stream-shaped, not query-shaped: there is nothing to filter into. -->
  <BarRows {rows} unit="visitors" flags onfilter={null} />
{/if}
