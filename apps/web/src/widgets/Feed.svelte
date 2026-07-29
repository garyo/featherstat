<script lang="ts">
import { inScope, relativeAgo } from '../lib/realtime.ts';
import { countryName, flagEmoji } from '../widgets/geo.ts';
import { dotColor } from './alias-colors.ts';
import { type WidgetProps } from './types.ts';

/**
 * The live-feed widget: the Realtime view's feed, card-sized (docs/05 `feed`).
 * No query — it rides the SSE stream every view already holds, so adding it to
 * a dashboard costs zero batch work (CLAUDE.md invariant 1 untouched). The
 * Realtime view remains the full-fat sibling (tally, hover-highlight,
 * engagement); this one is glanceable rows only.
 */
let { spec, recent, scope = 'all', sites }: WidgetProps = $props();

const limit = $derived(feedLimit(spec.options.limit));
const shown = $derived((recent ?? []).filter((hit) => inScope(hit, scope)).slice(0, limit));

/** Ago labels tick while the card is mounted. */
let now = $state(Date.now());
$effect(() => {
  const timer = setInterval(() => {
    now = Date.now();
  }, 10_000);
  return () => clearInterval(timer);
});

function feedLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? Math.floor(raw) : 10;
  return Math.min(Math.max(value, 5), 50);
}

function whereOf(hit: (typeof shown)[number]): string {
  if (hit.city !== undefined && hit.country !== undefined) return `${hit.city}, ${hit.country}`;
  if (hit.country !== undefined) return countryName(hit.country);
  return 'Unknown';
}

function whatOf(hit: (typeof shown)[number]): string {
  if (hit.type === 'event') {
    const action = hit.eventAction ?? 'event';
    return hit.eventCategory !== undefined ? `${hit.eventCategory} · ${action}` : action;
  }
  return hit.path ?? '/';
}

const siteNameOf = (id: number): string => sites?.get(id)?.name ?? `Site ${id}`;
</script>

<h2>{spec.title ?? 'Realtime'}</h2>
{#if recent === undefined}
  <p class="widget-note">Live feed — available in the app, not in shared views.</p>
{:else if shown.length === 0}
  <p class="widget-note">Waiting for the first hit…</p>
{:else}
  <div class="feed" role="list">
    {#each shown as hit, i (i)}
      <div class="feed-row" role="listitem">
        <span class="ago">{relativeAgo(hit.ts, now)}</span>
        <span class="vdot" style="background: {dotColor(hit.visitor.color)}"></span>
        <span class="vname">{hit.visitor.name}</span>
        {#if hit.country !== undefined}
          {@const flag = flagEmoji(hit.country)}
          {#if flag !== undefined}<span class="flag" title={countryName(hit.country)}>{flag}</span
            >{/if}
        {/if}
        <span class="where">{whereOf(hit)}</span>
        <span class="path">
          {#if hit.type === 'event'}<span class="evt-dot"></span>{/if}{whatOf(hit)}
        </span>
        {#if scope === 'all'}<span class="fsite">{siteNameOf(hit.siteId)}</span>{/if}
      </div>
    {/each}
  </div>
{/if}
