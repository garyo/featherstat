<script lang="ts">
import { countryRows, countryTally, inScope } from '../lib/realtime.ts';
import BarRows from './BarRows.svelte';
import type { WidgetProps } from './types.ts';

/** Where the last half hour came from — the shared bar rows, fed by the stream. */
let { spec, recent, scope = 'all', now = Date.now() }: WidgetProps = $props();

const rows = $derived(
  countryRows(
    countryTally(
      (recent ?? []).filter((hit) => inScope(hit, scope)),
      now,
    ),
  ),
);
</script>

<h2>{spec.title ?? 'Countries · last 30 min'}</h2>
{#if rows.length === 0}
  <p class="widget-note">No located visitors in the last 30 minutes.</p>
{:else}
  <BarRows {rows} unit="visitors" flags />
{/if}
