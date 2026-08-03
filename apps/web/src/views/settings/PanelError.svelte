<script lang="ts">
import type { PanelFailure } from '../../lib/admin-failure.ts';

/**
 * How a settings panel reports a mutation that failed — one rendering, so the
 * urgent case (expired session, unreachable server) cannot be strengthened in
 * one card and forgotten in the next. Placed beside the button that was clicked.
 */
interface Props {
  failure: PanelFailure | undefined;
}

let { failure }: Props = $props();
</script>

{#if failure !== undefined}
  <p class="form-error" class:urgent={failure.urgent} role="alert">{failure.message}</p>
{/if}
