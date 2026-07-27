<script lang="ts">
import type { QueryRequest, SiteInfo } from '@analytics/shared';
import { allSites } from '../dashboards/all-sites.ts';
import type { QueryClient } from '../lib/api.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch } from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  client: QueryClient;
  live: LiveStream;
  /** Active-now by site id, maintained at the app level from the SSE stream. */
  active: Record<number, number>;
  /** The site directory; undefined while loading — the batch waits for it, so the
   * view still issues exactly ONE `/api/query` (with the R20 page queries aboard). */
  sites: SiteInfo[] | undefined;
  byId: ReadonlyMap<number, SiteInfo>;
  onselectsite: (site: number) => void;
}

let { client, live, active, sites, byId, onselectsite }: Props = $props();

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

/**
 * 30 daily buckets cover the 14-day sparklines, the same-weekday-last-week
 * delta, and the per-page trends (R20) — one query for the cards plus one
 * top-pages query per site, all in the same batch.
 */
const dashboard = $derived(allSites((sites ?? []).map((site) => site.id)));
const request = $derived.by<QueryRequest>(() => ({
  site: 'all',
  range: { preset: '30d' },
  queries: collectBatch(dashboard).queries,
}));

$effect(() => {
  if (sites === undefined) return; // one batch, once the directory is in
  runner.run(request);
});
$effect(() =>
  createRevalidator(
    live,
    () => {
      if (sites !== undefined) runner.run(request);
    },
    { site: () => 'all', key: () => request },
  ),
);

const note = $derived(
  runner.error !== undefined && runner.response !== undefined
    ? 'Live update failed — showing the last good result'
    : 'Today so far · deltas vs the same day last week · sparklines: 14 days',
);
</script>

<div class="filters">
  <span class="compare-note">{note}</span>
  {#if runner.error !== undefined}
    <button class="retry" type="button" onclick={() => runner.retry()}>Retry</button>
  {/if}
</div>
<DashboardGrid
  {dashboard}
  response={runner.response}
  error={runner.error}
  refetching={runner.refetching}
  {active}
  sites={byId}
  {onselectsite}
/>
