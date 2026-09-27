<script lang="ts">
import type { Filter, FilterNode, Query, QueryRequest } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import { loadChunk } from '../lib/chunks.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { builtTemplate } from '../lib/dashboards.ts';
import type { EditorMode } from '../lib/editor-mode.svelte.ts';
import { sameFilter } from '../lib/filters.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { applyPivots } from '../lib/pivots.ts';
import {
  type CompareChoice,
  compareNote,
  compareParam,
  type DashRef,
  type DetailRef,
  failureNote,
  heldRange,
  latestLocalDay,
  localDayKey,
  type PivotChoice,
  toRange,
  type ViewRange,
} from '../lib/state.ts';
import { dashboardEnv } from '../widgets/env.ts';
import { windowLabel, zoneLabel } from '../widgets/format.ts';
import type { AppEnv } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';
import {
  collectBatch,
  hourlyWhenIntraday,
  wantsAnnotations,
  withoutBlockedMetrics,
} from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  /** What the app can offer this page's widgets — stream, directory, clock, nav. */
  app: AppEnv;
  admin: AdminClient;
  client: QueryClient;
  live: LiveStream;
  /** The scope's dashboard library + selection — owned by the Shell, which also
   * feeds the header switcher from it (docs/05 § The dashboard library). */
  store: DashboardStore;
  /** Edit mode — owned by the Shell, whose switcher guards an open draft. */
  mode: EditorMode;
  site: number;
  /** The site's IANA timezone (site directory) — its midnight re-runs the batch. */
  timezone: string | undefined;
  range: ViewRange;
  cmp: CompareChoice;
  filters: FilterNode[];
  segmentNames?: ReadonlyMap<number, string>;
  /** Per-widget breakdown overrides from the URL (docs/05 § Pivots). */
  pivots: PivotChoice[];
  onselectrange: (range: ViewRange) => void;
  onselectcmp: (cmp: CompareChoice) => void;
  /** Saving while a TEMPLATE is up clones it — the URL then points at the clone. */
  onselectdash: (dash: DashRef) => void;
  /** Chips changed (row clicked, chip removed): one URL update, one re-batch. */
  onfilters: (filters: FilterNode[]) => void;
  /** Opens the shared expression editor (docs/05 § Filters). */
  oneditfilters?: () => void;
  onpivots: (pivots: PivotChoice[]) => void;
  /** Opens an entity's detail view (a history push — back returns here). */
  onopendetail: (detail: DetailRef) => void;
}

let {
  app,
  admin,
  client,
  live,
  store,
  mode,
  site,
  timezone,
  range,
  cmp,
  filters,
  segmentNames,
  pivots,
  onselectrange,
  onselectcmp,
  onselectdash,
  onfilters,
  oneditfilters,
  onpivots,
  onopendetail,
}: Props = $props();

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

// The library selection: a stored row's layout, or a shipped template built
// fresh — the scope's default when nothing (or nothing readable) is selected.
const saved = $derived(
  store.stored ??
    builtTemplate(
      store.selection?.kind === 'template' ? store.selection.template.id : undefined,
      site,
    ),
);
// Pivots overlay the document BEFORE the batch is collected (invariant 1 holds
// trivially: one batch, over the pivoted specs, derived companions recomputed).
const dashboard = $derived(applyPivots(saved, pivots));

/** Pivot one widget; picking its saved breakdown back lifts the overlay. */
function setPivot(widget: string, dim: PivotChoice['dim']): void {
  const kept = pivots.filter((pivot) => pivot.widget !== widget);
  const spec = saved.grid.find((entry) => entry.id === widget);
  const original =
    spec?.query !== undefined && !('kind' in spec.query) ? spec.query.dim : undefined;
  onpivots(original === dim ? kept : [...kept, { widget, dim }]);
}

/** This view's request shape — also the editor's preview context (batch of one widget). */
const requestFor = (queries: readonly Query[]): QueryRequest => {
  const compare = compareParam(cmp);
  return {
    site,
    range: toRange(range),
    ...(compare === undefined ? {} : { compare }),
    ...(filters.length > 0 ? { filters } : {}),
    // Opt in to `meta.annotations` exactly when something here draws markers.
    ...(wantsAnnotations(dashboard) ? { annotations: true as const } : {}),
    queries: withoutBlockedMetrics(hourlyWhenIntraday(queries, range), filters),
  };
};

const request = $derived.by<QueryRequest>(() => requestFor(collectBatch(dashboard).queries));

// One batch per view state, held until the dashboard lookup answers (still ONE
// fetch — never a default-then-stored double batch); re-issued on state change …
$effect(() => {
  // The rollover is part of "view state": `today`/`mtd` — and an explicit range
  // touching today — are resolved server-side, so their answer changes at this
  // site's own midnight.
  void dayKey;
  if (store.ready) runner.run(request);
});
// … and when debounced version ticks say this site's data moved (docs/05 R22).
// The key voids a window armed for a state the user has since left: that state
// change ran its own batch, and the timer must not re-issue (and abort) it.
$effect(() =>
  createRevalidator(
    live,
    () => {
      if (store.ready) runner.refresh();
    },
    {
      site: () => site,
      key: () => request,
    },
  ),
);

const zones = $derived(timezone === undefined ? [] : [timezone]);
const dayKey = $derived(localDayKey(zones, new Date(app.now)));
const today = $derived(latestLocalDay(zones, app.now));

/** Save, then point the URL at the row — editing a template just cloned it. */
async function save(next: Parameters<typeof mode.save>[0]): Promise<void> {
  const wasTemplate = store.selection?.kind === 'template';
  if ((await mode.save(next)) && wasTemplate && store.id !== undefined) onselectdash(store.id);
}

// Share links are admin chrome: another code-split chunk, loaded on first use.
let ShareDialog = $state<typeof import('../share/dialog.ts').ShareDialog | undefined>(undefined);
async function openShare(): Promise<void> {
  ShareDialog = (await loadChunk(() => import('../share/dialog.ts')))?.ShareDialog;
}

/** Click-to-filter (docs/05): a repeated chip is a no-op, not a duplicate. */
function addFilter(filter: Filter): void {
  if (filters.some((existing) => sameFilter(existing, filter))) return;
  onfilters([...filters, filter]);
}

function removeFilter(index: number): void {
  onfilters(filters.filter((_, i) => i !== index));
}

const failed = $derived(runner.error !== undefined && runner.response !== undefined);
/** On screen but not this state's: in flight, or held back until the lookup answers. */
const refetching = $derived(runner.refetching || (!store.ready && runner.response !== undefined));
/** The range actually on screen — while refetching, the held response's, not the pill's. */
const held = $derived(heldRange(runner.held, range));
/**
 * The window the SERVER resolved for the response on screen (`meta.windows`) —
 * so the label can never describe a different range from the data beside it, and
 * a page left open past this site's midnight moves both at once (the batch
 * re-runs on `dayKey`). The browser resolves no presets.
 */
const span = $derived(windowLabel(runner.response?.meta.windows));
const zone = $derived(zoneLabel(runner.response?.meta.windows));
/**
 * ONE environment for this page, handed to the dashboard AND to the editor's
 * preview — the preview used to be assembled from a shorter list of props, so
 * it rendered without the range qualifier, click-to-filter or the realtime jump.
 * It follows the range on SCREEN, not the pill, so a refetch cannot label held
 * data with the range being loaded.
 */
const env = $derived(
  dashboardEnv(app, {
    scope: site,
    range: held,
    onfilter: addFilter,
    ondrill: (dim, value) => onopendetail({ dim, value }),
    onpivot: setPivot,
  }),
);
const note = $derived.by(() => {
  if (failed) {
    // A user-initiated change that never landed reads differently from a live
    // revalidation failure — and says what is actually on screen.
    return failureNote(runner.stale, range, held);
  }
  const compared = compareNote(held, cmp) ?? 'no comparison';
  if (span === undefined) return compared.charAt(0).toUpperCase() + compared.slice(1);
  return `${span} · ${zone} · ${compared}`;
});
</script>

{#if mode.Editor !== undefined}
  {@const Editor = mode.Editor}
  <!-- A draft belongs to one dashboard: a new scope or selection is a new editor. -->
  {#key `${site}|${store.selection?.ref}`}
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
      ondirty={mode.setDirty}
    />
  {/key}
{:else}
  <div class="toolbar">
    <FilterRow
      {range}
      {cmp}
      {filters}
      {segmentNames}
      {oneditfilters}
      {note}
      {today}
      onselect={onselectrange}
      oncompare={onselectcmp}
      onremovefilter={removeFilter}
      onretry={runner.error === undefined ? undefined : () => runner.refresh()}
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
    {refetching}
    {env}
  />
{/if}

<!-- The saved layout, not the pivoted one: a pivot is transient view state, and
     share links ignore it (docs/05 § Pivots). -->
{#if ShareDialog !== undefined}
  <ShareDialog
    {admin}
    {store}
    layout={{ ...saved, site }}
    {onselectdash}
    onclose={() => (ShareDialog = undefined)}
  />
{/if}

