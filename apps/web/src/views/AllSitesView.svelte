<script lang="ts">
import type { Query, QueryRequest } from '@featherstat/shared';
import { allSites } from '../dashboards/all-sites.ts';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import { createDashboardStore } from '../lib/dashboards.svelte.ts';
import { withLiveSiteIds } from '../lib/dashboards.ts';
import { createEditorMode } from '../lib/editor-mode.svelte.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { localDayKey, type RangePreset } from '../lib/state.ts';
import { dashboardEnv } from '../widgets/env.ts';
import type { AppEnv } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch, hourlyWhenIntraday } from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  /** What the app can offer this page's widgets — stream, directory, clock, nav.
   * `app.sites` is null while the directory loads: the batch waits for it, so the
   * view still issues exactly ONE `/api/query` (with the R20 page queries aboard). */
  app: AppEnv;
  admin: AdminClient;
  client: QueryClient;
  live: LiveStream;
  range: RangePreset;
  onselectrange: (range: RangePreset) => void;
}

let { app, admin, client, live, range, onselectrange }: Props = $props();

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
const siteIds = $derived(app.sites === null ? [] : [...app.sites.keys()]);
const dashboard = $derived(withLiveSiteIds(store.stored ?? allSites(siteIds), siteIds));

/** This view's request shape — also the editor's preview context. */
const requestFor = (queries: readonly Query[]): QueryRequest => ({
  site: 'all',
  range: { preset: range },
  compare: 'previous',
  queries: hourlyWhenIntraday([...queries], range),
});

const request = $derived.by<QueryRequest>(() => requestFor(collectBatch(dashboard).queries));

$effect(() => {
  // One batch, once the directory AND the dashboard lookup are in — and once
  // more when a site rolls into a new local day, because `today` and `mtd`
  // are resolved server-side and their answer changes at that site's midnight.
  void dayKey;
  if (app.sites !== null && store.ready) runner.run(request);
});
$effect(() =>
  createRevalidator(
    live,
    () => {
      if (app.sites !== null && store.ready) runner.run(request);
    },
    { site: () => 'all', key: () => request },
  ),
);

const dayKey = $derived(
  localDayKey(
    app.sites === null ? [] : [...app.sites.values()].map((entry) => entry.timezone),
    new Date(app.now),
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

/** ONE environment for the dashboard AND the editor's preview (see SiteView). */
const env = $derived(dashboardEnv(app, { scope: 'all', range, onfilter: null }));

const note = $derived(
  runner.error !== undefined && runner.response !== undefined
    ? 'Live update failed — showing the last good result'
    : 'compared with the previous period · active-now is live',
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
    {env}
    saving={store.saving}
    saveError={store.error}
    onsave={(next) => void mode.save(next)}
    oncancel={() => mode.close()}
  />
{:else}
  <div class="toolbar">
    <FilterRow
      {range}
      {note}
      onselect={onselectrange}
      onretry={runner.error === undefined ? undefined : () => runner.retry()}
    />
    <button
      class="btn slim tool-btn"
      type="button"
      title="Share dashboard"
      onclick={() => void openShare()}>Share</button
    >
    <button
      class="btn slim tool-btn"
      type="button"
      title="Edit dashboard"
      onclick={() => void mode.open()}>Edit</button
    >
  </div>
  <DashboardGrid
    {dashboard}
    response={runner.response}
    error={runner.error}
    refetching={runner.refetching}
    {env}
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
