<script lang="ts">
import type { WidgetProps } from './types.ts';

/** The live hero: distinct visitors in the last five minutes, from the stream. */
let { active, scope = 'all' }: WidgetProps = $props();

const count = $derived(
  scope === 'all'
    ? Object.values(active ?? {}).reduce((sum, n) => sum + n, 0)
    : (active?.[scope] ?? 0),
);
</script>

<div class="active-now">
  {#if count > 0}<span class="pulse"></span>{:else}<span class="idle"></span>{/if}
  <span class="n">{count}</span>
  <span class="active-label">active now</span>
</div>
