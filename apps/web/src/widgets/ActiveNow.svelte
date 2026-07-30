<script lang="ts">
import { activeCount } from '../lib/realtime.ts';
import type { WidgetProps } from './types.ts';

/** The live hero: distinct visitors in the last five minutes, from the stream. */
let { env }: WidgetProps = $props();

const count = $derived(activeCount(env.realtime, env.scope));
</script>

<div class="active-now">
  {#if count > 0}<span class="pulse"></span>{:else}<span class="idle"></span>{/if}
  <span class="n">{count}</span>
  <span class="active-label">active now</span>
</div>
