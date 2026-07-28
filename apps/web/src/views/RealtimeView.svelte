<script lang="ts">
import type { RealtimeHit, SiteInfo } from '@featherstat/shared';
import {
  countryTally,
  FEED_SHOW,
  inScope,
  relativeAgo,
  type VisitorCount,
  visitorTally,
} from '../lib/realtime.ts';
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
  /** Site directory for the per-row badges shown when the scope is 'all'. */
  sites: SiteInfo[] | undefined;
}

let { active, recent, site, sites }: Props = $props();

/**
 * Alias dot colors: the chart-safe categorical tokens, CYCLED by index. That is
 * deliberate — visitor identity is carried by the NAME, the dot only aids
 * scanning — so the dataviz never-cycle rule for data series does not apply.
 */
const ALIAS_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

const siteNameOf = (id: number): string =>
  sites?.find((entry) => entry.id === id)?.name ?? `Site ${id}`;

/** Alias under the cursor — its every row lights up, feed and tally alike. */
let hover = $state<string | undefined>(undefined);

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
const visitors = $derived(visitorTally(scoped, now));

function dotColor(color: number): string {
  return ALIAS_COLORS[color % ALIAS_COLORS.length] ?? 'var(--s1)';
}

function placeOf(row: VisitorCount): string | undefined {
  if (row.city !== undefined) return row.city;
  return row.country !== undefined ? countryName(row.country) : undefined;
}

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
    {#if visitors.length > 0}
      <div class="visitor-tally" role="list">
        {#each visitors as row (row.name)}
          {@const place = placeOf(row)}
          <div
            class="visitor-row"
            role="listitem"
            class:hl={hover === row.name}
            onmouseenter={() => (hover = row.name)}
            onmouseleave={() => (hover = undefined)}
          >
            <span class="vdot" style="background: {dotColor(row.color)}"></span>
            <span class="vname">{row.name}</span>
            <span class="vmeta"
              >· {row.count}
              {row.count === 1 ? 'hit' : 'hits'}{place !== undefined ? ` · ${place}` : ''}{site ===
              'all'
                ? ` · ${siteNameOf(row.siteId)}`
                : ''}</span
            >
          </div>
        {/each}
      </div>
    {/if}
    {#if shown.length === 0}
      <p class="widget-note">Waiting for the first hit…</p>
    {:else}
      <div class="feed" role="list">
        {#each shown as hit, i (i)}
          <div
            class="feed-row"
            role="listitem"
            class:hl={hover === hit.visitor.name}
            onmouseenter={() => (hover = hit.visitor.name)}
            onmouseleave={() => (hover = undefined)}
          >
            <span class="ago">{relativeAgo(hit.ts, now)}</span>
            <span class="vdot" style="background: {dotColor(hit.visitor.color)}"></span>
            <span class="vname">{hit.visitor.name}</span>
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
            {#if site === 'all'}<span class="fsite">{siteNameOf(hit.siteId)}</span>{/if}
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

<style>
  .fsite {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
</style>
