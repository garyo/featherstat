<script lang="ts" generics="T">
import type { Snippet } from 'svelte';
import type { LoadView } from '../../lib/loader.svelte.ts';

/**
 * What a settings card shows for a remote read (`lib/loader.svelte.ts`): the
 * answer, "Loading…", or a failure with a way to try again — one rendering, so
 * no card can be left stuck on "unavailable" again.
 */
interface Props {
  of: LoadView<T>;
  /** The noun a failure is about: "Goals" → "Goals unavailable." */
  what: string;
  children: Snippet<[T]>;
}

let { of, what, children }: Props = $props();
</script>

{#if of.failed}
  <p class="widget-note">
    {what} unavailable.
    <button class="btn subtle" type="button" onclick={() => void of.reload()}>Retry</button>
  </p>
{:else if of.value === undefined}
  <p class="widget-note">Loading…</p>
{:else}
  {@render children(of.value)}
{/if}
