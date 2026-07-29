<script lang="ts">
import { inScope } from '../lib/realtime.ts';
import FeedRows from './FeedRows.svelte';
import type { WidgetProps } from './types.ts';

/**
 * The live-feed widget (docs/05 `feed`): the Realtime view's feed, card-sized.
 * No query — it rides the SSE stream every view already holds, so adding it to
 * a dashboard costs zero batch work (CLAUDE.md invariant 1). The rows are
 * FeedRows, the same component the Realtime view renders: this widget is a
 * frame around it, never a second copy of it.
 */
let {
  spec,
  recent,
  scope = 'all',
  sites,
  onopenrealtime,
  headless = false,
  hover: sharedHover,
  onhover,
  now: sharedNow,
}: WidgetProps = $props();

/** Own highlight when standalone; a composing view can share one instead. */
let localHover = $state<string | undefined>(undefined);
const hover = $derived(onhover === undefined ? localHover : sharedHover);

const limit = $derived(feedLimit(spec.options.limit));
const shown = $derived((recent ?? []).filter((hit) => inScope(hit, scope)).slice(0, limit));

/** Ago labels tick while the card is mounted. */
let ownNow = $state(Date.now());
$effect(() => {
  const timer = setInterval(() => {
    ownNow = Date.now();
  }, 10_000);
  return () => clearInterval(timer);
});

function feedLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? Math.floor(raw) : 10;
  return Math.min(Math.max(value, 5), 50);
}
</script>

{#if headless}
  <!-- heading supplied by the composing view -->
{:else if onopenrealtime === undefined}
  <h2>{spec.title ?? 'Realtime'}</h2>
{:else}
  <h2>
    <button class="h2link" type="button" onclick={onopenrealtime}>{spec.title ?? 'Realtime'}</button>
  </h2>
{/if}
{#if recent === undefined}
  <p class="widget-note">Live feed — available in the app, not in shared views.</p>
{:else if shown.length === 0}
  <p class="widget-note">Waiting for the first hit…</p>
{:else}
  <FeedRows hits={shown} now={sharedNow ?? ownNow} {scope} {sites} {hover} onhover={(name) => (onhover === undefined ? (localHover = name) : onhover(name))} />
{/if}
