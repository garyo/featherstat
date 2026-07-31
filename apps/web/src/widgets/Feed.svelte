<script lang="ts">
import { scopedHits } from '../lib/realtime.ts';
import FeedRows from './FeedRows.svelte';
import type { WidgetProps } from './types.ts';

/**
 * The live-feed widget (docs/05 `feed`): the Realtime view's feed, card-sized.
 * No query — it rides the SSE stream every view already holds, so adding it to
 * a dashboard costs zero batch work (CLAUDE.md invariant 1). The rows are
 * FeedRows, the same component the Realtime view renders: this widget is a
 * frame around it, never a second copy of it.
 */
let { spec, env }: WidgetProps = $props();

/** Own highlight when standalone; a composing page can share one instead. Both
 * hold the visitor's `ref` — the alias collides (invariant 8). */
let localHover = $state<string | undefined>(undefined);
const hover = $derived(env.highlight === null ? localHover : env.highlight.ref);

const limit = $derived(feedLimit(spec.options.limit));
// All of them: FeedRows collapses first and applies the limit to ROWS.
const shown = $derived(scopedHits(env.realtime, env.scope));

/** `8s`, `4m` need a finer clock than the page's: this card owns its own tick,
 * which is why the environment's coarser `now` stays for the charts. */
let now = $state(Date.now());
$effect(() => {
  const timer = setInterval(() => {
    now = Date.now();
  }, 10_000);
  return () => clearInterval(timer);
});

function setHover(ref: string | undefined): void {
  if (env.highlight === null) localHover = ref;
  else env.highlight.onhover(ref);
}

function feedLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? Math.floor(raw) : 10;
  return Math.min(Math.max(value, 5), 50);
}
</script>

{#if env.headless}
  <!-- heading supplied by the composing view -->
{:else if env.onopenrealtime === null}
  <h2>{spec.title ?? 'Realtime'}</h2>
{:else}
  <h2>
    <button class="h2link" type="button" onclick={env.onopenrealtime}
      >{spec.title ?? 'Realtime'}</button
    >
  </h2>
{/if}
{#if shown.length === 0}
  <p class="widget-note">Waiting for the first hit…</p>
{:else}
  <FeedRows
    hits={shown}
    {limit}
    {now}
    scope={env.scope}
    sites={env.sites}
    {hover}
    onhover={setHover}
  />
{/if}
