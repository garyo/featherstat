<script lang="ts">
import type { QueryRequest } from '@analytics/shared';
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
  onselectsite: (site: number) => void;
}

let { client, live, active, onselectsite }: Props = $props();

const { queries } = collectBatch(allSites);
// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

/** 30 daily buckets cover the 14-day sparkline and the same-weekday-last-week delta. */
const request: QueryRequest = { site: 'all', range: { preset: '30d' }, queries };

$effect(() => {
  runner.run(request);
});
$effect(() => createRevalidator(live, () => runner.run(request), { site: () => 'all' }));

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
  dashboard={allSites}
  response={runner.response}
  error={runner.error}
  refetching={runner.refetching}
  {active}
  {onselectsite}
/>
