<script lang="ts">
import type { Query, QueryRequest, SiteInfo } from '@featherstat/shared';
import { allSites } from '../dashboards/all-sites.ts';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import { createDashboardStore } from '../lib/dashboards.svelte.ts';
import { withLiveSiteIds } from '../lib/dashboards.ts';
import { createEditorMode } from '../lib/editor-mode.svelte.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch } from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  admin: AdminClient;
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

let { admin, client, live, active, sites, byId, onselectsite }: Props = $props();

// The clients are app-lifetime singletons; capturing their initial values is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);
// svelte-ignore state_referenced_locally
const store = createDashboardStore(admin);

$effect(() => {
  store.load('all');
});

/**
 * 30 daily buckets cover the 14-day sparklines, the same-weekday-last-week
 * delta, and the per-page trends (R20) — one query for the cards plus one
 * top-pages query per site, all in the same batch. A stored dashboard replaces
 * the shipped default, but its site-cards always follow the LIVE directory.
 */
const siteIds = $derived((sites ?? []).map((site) => site.id));
const dashboard = $derived(withLiveSiteIds(store.stored ?? allSites(siteIds), siteIds));

/** This view's request shape — also the editor's preview context. */
const requestFor = (queries: readonly Query[]): QueryRequest => ({
  site: 'all',
  range: { preset: '30d' },
  queries: [...queries],
});

const request = $derived.by<QueryRequest>(() => requestFor(collectBatch(dashboard).queries));

$effect(() => {
  // one batch, once the directory AND the dashboard lookup are in
  if (sites !== undefined && store.ready) runner.run(request);
});
$effect(() =>
  createRevalidator(
    live,
    () => {
      if (sites !== undefined && store.ready) runner.run(request);
    },
    { site: () => 'all', key: () => request },
  ),
);

// Edit mode (docs/05): the editor is a code-split chunk, loaded on entry.
// svelte-ignore state_referenced_locally
const mode = createEditorMode(store, () => 'all');

// Share links are admin chrome: another code-split chunk, loaded on first use.
let ShareDialog = $state<typeof import('../share/dialog.ts').ShareDialog | undefined>(undefined);
async function openShare(): Promise<void> {
  ShareDialog = (await import('../share/dialog.ts')).ShareDialog;
}

const note = $derived(
  runner.error !== undefined && runner.response !== undefined
    ? 'Live update failed — showing the last good result'
    : 'Today so far · deltas vs the same day last week · sparklines: 14 days',
);
</script>

{#if mode.Editor !== undefined}
  {@const Editor = mode.Editor}
  <Editor
    initial={dashboard}
    {client}
    request={requestFor}
    response={runner.response}
    error={runner.error}
    {active}
    sites={byId}
    saving={store.saving}
    saveError={store.error}
    onsave={(next) => void mode.save(next)}
    oncancel={() => mode.close()}
  />
{:else}
  <div class="filters">
    <span class="compare-note">{note}</span>
    {#if runner.error !== undefined}
      <button class="retry" type="button" onclick={() => runner.retry()}>Retry</button>
    {/if}
    <span class="spacer"></span>
    <button class="btn slim" type="button" title="Share dashboard" onclick={() => void openShare()}
      >Share</button
    >
    <button class="btn slim" type="button" title="Edit dashboard" onclick={() => void mode.open()}
      >Edit</button
    >
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
{/if}

{#if ShareDialog !== undefined}
  <ShareDialog
    {admin}
    {store}
    layout={{ ...dashboard, site: 'all' }}
    onclose={() => (ShareDialog = undefined)}
  />
{/if}
