<script lang="ts">
import { resultAxes } from './axis.ts';
import { exactNumber } from './format.ts';
import Sparkline from './Sparkline.svelte';
import { siteSortOf, siteStats } from './site-stats.ts';
import { topPages } from './top-pages.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let {
  spec,
  data,
  active,
  sites,
  onselectsite,
  windows,
  range = '30d',
  rangeLabel,
  now,
}: WidgetProps = $props();

const slice = $derived(sliceOf(data, 'main'));
// Each card rides its OWN site's axis: the batch spans timezones, and one shared
// clock zeroes whole cards for the hours around a midnight.
const axes = $derived(
  slice.kind === 'ready' ? resultAxes(slice.result, windows ?? [], now ?? Date.now()) : [],
);
const stats = $derived(
  slice.kind === 'ready'
    ? siteStats(
        axes,
        slice.result.rows,
        slice.result.compare,
        sites === undefined ? undefined : [...sites.values()],
        siteSortOf(spec.options.sort),
      )
    : [],
);
const periodLabel = $derived((rangeLabel ?? range).toLowerCase());

/** R20: this site's top pages over the card's own window (per-site clock). */
function pagesFor(site: number, buckets: readonly string[]): ReturnType<typeof topPages> {
  const pages = sliceOf(data, `pages~${site}`);
  return pages.kind === 'ready' ? topPages(pages.result.rows, buckets) : [];
}

function select(site: number): void {
  onselectsite?.(site);
}

function onKeydown(event: KeyboardEvent, site: number): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    select(site);
  }
}
</script>

<div class="sites">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if stats.length === 0}
    <p class="widget-note">No traffic in this period.</p>
  {:else}
    {#each stats as stat (stat.site)}
      {@const now = active?.[stat.site] ?? 0}
      {@const pages = pagesFor(stat.site, stat.buckets)}
      <div
        class="site-card"
        role="button"
        tabindex="0"
        onclick={() => select(stat.site)}
        onkeydown={(event) => onKeydown(event, stat.site)}
      >
        <div class="top">
          <span class="domain">{sites?.get(stat.site)?.name ?? `Site ${stat.site}`}</span>
          <span class="active">
            {#if now > 0}<span class="pulse"></span> {now} now{:else}<span class="idle"></span>
              quiet{/if}
          </span>
        </div>
        <div class="nums">
          <span class="today">{exactNumber(stat.total)}</span>
          {#if stat.deltaPct === undefined}
            <span class="delta muted">—</span>
          {:else}
            <span class="delta {stat.deltaPct >= 0 ? 'up' : 'down'}">
              {stat.deltaPct >= 0 ? '▴ +' : '▾ −'}{Math.abs(stat.deltaPct)}%
            </span>
          {/if}
          <span class="sub">visitors · {periodLabel}</span>
        </div>
        {#if stat.silent}
          <!-- A site with zero rows is exactly the one to surface: a fresh site
               waiting for its first hit, or a mis-installed snippet. -->
          <p class="widget-note">Waiting for the first hit — check the snippet in Settings.</p>
        {:else}
          <div class="spark">
            <Sparkline data={stat.spark} width={280} height={40} accent stretch />
          </div>
        {/if}
        {#if pages.length > 0}
          <div class="pages">
            {#each pages as page (page.path)}
              <div class="page-row">
                <span class="p">{page.path}</span>
                <span class="micro">
                  <Sparkline data={page.spark} width={52} height={16} micro />
                </span>
                {#if page.deltaPct === undefined}
                  <span class="d delta muted">—</span>
                {:else}
                  <span class="d delta {page.deltaPct >= 0 ? 'up' : 'down'}">
                    {page.deltaPct >= 0 ? '▴ +' : '▾ −'}{Math.abs(page.deltaPct)}%
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
