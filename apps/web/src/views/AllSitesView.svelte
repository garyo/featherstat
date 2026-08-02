<script lang="ts">
import type { Query, QueryRequest } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { builtTemplate, withLiveSiteIds } from '../lib/dashboards.ts';
import { createEditorMode } from '../lib/editor-mode.svelte.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import {
  type CompareChoice,
  compareNote,
  compareParam,
  type DashRef,
  localDayKey,
  toRange,
  type ViewRange,
} from '../lib/state.ts';
import { dashboardEnv } from '../widgets/env.ts';
import type { AppEnv } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch, hourlyWhenIntraday, wantsAnnotations } from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  /** What the app can offer this page's widgets — stream, directory, clock, nav.
   * `app.sites` is null while the directory loads: the batch waits for it, so the
   * view still issues exactly ONE `/api/query` (with the R20 page queries aboard). */
  app: AppEnv;
  admin: AdminClient;
  client: QueryClient;
  live: LiveStream;
  /** The scope's dashboard library + selection — owned by the Shell (see SiteView). */
  store: DashboardStore;
  range: ViewRange;
  cmp: CompareChoice;
  onselectrange: (range: ViewRange) => void;
  onselectcmp: (cmp: CompareChoice) => void;
  onselectdash: (dash: DashRef) => void;
}

let {
  app,
  admin,
  client,
  live,
  store,
  range,
  cmp,
  onselectrange,
  onselectcmp,
  onselectdash,
}: Props = $props();

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

/**
 * 30 daily buckets cover the 14-day sparklines, the same-weekday-last-week
 * delta, and the per-page trends (R20) — one query for the cards plus one
 * top-pages query per site, all in the same batch. The library selection (a
 * stored row, or the shipped all-sites template) always follows the LIVE
 * directory for its site-cards.
 */
const siteIds = $derived(app.sites === null ? [] : [...app.sites.keys()]);
const dashboard = $derived(
  withLiveSiteIds(
    store.stored ??
      builtTemplate(
        store.selection?.kind === 'template' ? store.selection.template.id : undefined,
        'all',
        siteIds,
      ),
    siteIds,
  ),
);

/** This view's request shape — also the editor's preview context. */
const requestFor = (queries: readonly Query[]): QueryRequest => {
  const compare = compareParam(cmp);
  return {
    site: 'all',
    range: toRange(range),
    ...(compare === undefined ? {} : { compare }),
    // The shipped all-sites template has no timeseries, but a stored layout may.
    ...(wantsAnnotations(dashboard) ? { annotations: true as const } : {}),
    queries: hourlyWhenIntraday([...queries], range),
  };
};

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

/** Save, then point the URL at the row — editing a template just cloned it. */
async function save(next: Parameters<typeof mode.save>[0]): Promise<void> {
  const wasTemplate = store.selection?.kind === 'template';
  if ((await mode.save(next)) && wasTemplate && store.id !== undefined) onselectdash(store.id);
}

// Share links are admin chrome: another code-split chunk, loaded on first use.
let ShareDialog = $state<typeof import('../share/dialog.ts').ShareDialog | undefined>(undefined);
async function openShare(): Promise<void> {
  ShareDialog = (await import('../share/dialog.ts')).ShareDialog;
}

/** ONE environment for the dashboard AND the editor's preview (see SiteView).
 * Detail views are per-site, so the all-sites grid offers no drill or pivot. */
const env = $derived(
  dashboardEnv(app, { scope: 'all', range, onfilter: null, ondrill: null, onpivot: null }),
);

const note = $derived.by(() => {
  if (runner.error !== undefined && runner.response !== undefined) {
    return 'Live update failed — showing the last good result';
  }
  const compared = compareNote(range, cmp) ?? 'no comparison';
  return `${compared} · active-now is live`;
});
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
    onsave={(next) => void save(next)}
    oncancel={() => mode.close()}
  />
{:else}
  <div class="toolbar">
    <FilterRow
      {range}
      {cmp}
      {note}
      onselect={onselectrange}
      oncompare={onselectcmp}
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
      title={store.selection?.kind === 'template'
        ? 'Customize this built-in dashboard (saving creates your copy)'
        : 'Edit dashboard'}
      onclick={() => void mode.open()}
      >{store.selection?.kind === 'template' ? 'Customize' : 'Edit'}</button
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
