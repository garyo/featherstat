<script lang="ts">
import { exactNumber } from './format.ts';
import Sparkline from './Sparkline.svelte';
import { siteStats } from './site-stats.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { data, active, onselectsite }: WidgetProps = $props();

const slice = $derived(sliceOf(data, 'main'));
const stats = $derived(slice.kind === 'ready' ? siteStats(slice.result.rows) : []);

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
    <p class="widget-note">No traffic in the last 30 days.</p>
  {:else}
    {#each stats as stat (stat.site)}
      {@const now = active?.[stat.site] ?? 0}
      <div
        class="site-card"
        role="button"
        tabindex="0"
        onclick={() => select(stat.site)}
        onkeydown={(event) => onKeydown(event, stat.site)}
      >
        <div class="top">
          <!-- Site names need the admin API (WP13); ids are all the query vocabulary returns. -->
          <span class="domain">Site {stat.site}</span>
          <span class="active">
            {#if now > 0}<span class="pulse"></span> {now} now{:else}<span class="idle"></span>
              quiet{/if}
          </span>
        </div>
        <div class="nums">
          <span class="today">{exactNumber(stat.today)}</span>
          {#if stat.deltaPct === undefined}
            <span class="delta muted">—</span>
          {:else}
            <span class="delta {stat.deltaPct >= 0 ? 'up' : 'down'}">
              {stat.deltaPct >= 0 ? '▴ +' : '▾ −'}{Math.abs(stat.deltaPct)}%
            </span>
          {/if}
          <span class="sub">visitors today</span>
        </div>
        <div class="spark">
          <Sparkline data={stat.spark} width={280} height={40} accent stretch />
        </div>
      </div>
    {/each}
  {/if}
</div>
