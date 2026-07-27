<script lang="ts">
import type { RealtimeHit } from '@analytics/shared';
import { countryTally, FEED_SHOW, inScope, relativeAgo } from '../lib/realtime.ts';
import type { SiteScope } from '../lib/state.ts';
import { countryName, flagEmoji } from '../widgets/geo.ts';

/**
 * The Realtime view (docs/05): active-now hero, live feed, 30-minute country
 * tally — pure SSE, zero `/api/query` traffic. The world map ships in M2 with
 * the map-outline data (see the docs/05 amendment). The rolling hit list is
 * kept at the app level (like the active counts), so opening this tab late
 * still shows everything the stream has delivered.
 *
 * SECURITY: paths, cities and event names are visitor-controlled strings —
 * text interpolation ONLY (registry.ts boundary note applies here too).
 */
interface Props {
  /** Active-now by site id, maintained at the app level from the SSE stream. */
  active: Record<number, number>;
  /** App-level rolling feed, newest first, all sites. */
  recent: readonly RealtimeHit[];
  site: SiteScope;
}

let { active, recent, site }: Props = $props();

/** Clock for the `ago` labels and the tally window — ticks while the view is up. */
let now = $state(Date.now());
$effect(() => {
  const tick = setInterval(() => {
    now = Date.now();
  }, 5_000);
  return () => clearInterval(tick);
});

const activeNow = $derived(
  site === 'all'
    ? Object.values(active).reduce((sum, count) => sum + count, 0)
    : (active[site] ?? 0),
);
const scoped = $derived(recent.filter((hit) => inScope(hit, site)));
const shown = $derived(scoped.slice(0, FEED_SHOW));
const tally = $derived(countryTally(scoped, now));

function whereOf(hit: RealtimeHit): string {
  if (hit.city !== undefined && hit.country !== undefined) return `${hit.city}, ${hit.country}`;
  if (hit.country !== undefined) return countryName(hit.country);
  return 'Unknown';
}

function whatOf(hit: RealtimeHit): string {
  if (hit.type === 'event') {
    const action = hit.eventAction ?? 'event';
    // Mockup + Events card shape: `category · action`.
    return hit.eventCategory !== undefined ? `${hit.eventCategory} · ${action}` : action;
  }
  return hit.path ?? '/';
}
</script>

<div class="filters">
  <span class="compare-note">Live — every hit as it lands · one stream, no queries</span>
</div>

<div class="grid">
  <div class="card c6">
    <h2>Right now</h2>
    <div class="active-now">
      {#if activeNow > 0}<span class="pulse"></span>{:else}<span class="idle"></span>{/if}
      <span class="n">{activeNow}</span>
      <span class="active-label">active now</span>
    </div>
    {#if shown.length === 0}
      <p class="widget-note">Waiting for the first hit…</p>
    {:else}
      <div class="feed">
        {#each shown as hit, i (i)}
          <div class="feed-row">
            <span class="ago">{relativeAgo(hit.ts, now)}</span>
            {#if hit.country !== undefined}
              {@const flag = flagEmoji(hit.country)}
              {#if flag !== undefined}<span class="flag" title={countryName(hit.country)}
                  >{flag}</span
                >{/if}
            {/if}
            <span class="where">{whereOf(hit)}</span>
            <span class="path">
              {#if hit.type === 'event'}<span class="evt-dot"></span>{/if}{whatOf(hit)}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="card c6">
    <h2>Countries · last 30 min</h2>
    {#if tally.length === 0}
      <p class="widget-note">No located visitors in the last 30 minutes.</p>
    {:else}
      <div class="bar-list">
        {#each tally as row (row.country)}
          {@const flag = flagEmoji(row.country)}
          <div class="bar-row">
            <span class="bar" style="width: {row.pct}%"></span>
            <span class="name">
              {#if flag !== undefined}<span class="flag">{flag}</span>{/if}
              {countryName(row.country)}
            </span>
            <span class="num">{row.count}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
