<script lang="ts">
import type { Filter, Query, QueryRequest } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { builtTemplate } from '../lib/dashboards.ts';
import { createEditorMode } from '../lib/editor-mode.svelte.ts';
import { sameFilter } from '../lib/filters.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import {
  type CompareChoice,
  compareNote,
  compareParam,
  type DashRef,
  localDayKey,
  rangeQualifier,
  toRange,
  type ViewRange,
} from '../lib/state.ts';
import { dashboardEnv } from '../widgets/env.ts';
import { windowLabel } from '../widgets/format.ts';
import type { AppEnv } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch, hourlyWhenIntraday, withoutBlockedMetrics } from './batch.ts';
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
  site: number;
  /** The site's IANA timezone (site directory) — its midnight re-runs the batch. */
  timezone: string | undefined;
  range: ViewRange;
  cmp: CompareChoice;
  filters: Filter[];
  onselectrange: (range: ViewRange) => void;
  onselectcmp: (cmp: CompareChoice) => void;
  /** Saving while a TEMPLATE is up clones it — the URL then points at the clone. */
  onselectdash: (dash: DashRef) => void;
  /** Chips changed (row clicked, chip removed): one URL update, one re-batch. */
  onfilters: (filters: Filter[]) => void;
}

let {
  app,
  admin,
  client,
  live,
  store,
  site,
  timezone,
  range,
  cmp,
  filters,
  onselectrange,
  onselectcmp,
  onselectdash,
  onfilters,
}: Props = $props();

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

// The library selection: a stored row's layout, or a shipped template built
// fresh — the scope's default when nothing (or nothing readable) is selected.
const dashboard = $derived(
  store.stored ??
    builtTemplate(
      store.selection?.kind === 'template' ? store.selection.template.id : undefined,
      site,
    ),
);

/** This view's request shape — also the editor's preview context (batch of one widget). */
const requestFor = (queries: readonly Query[]): QueryRequest => {
  const compare = compareParam(cmp);
  return {
    site,
    range: toRange(range),
    ...(compare === undefined ? {} : { compare }),
    ...(filters.length > 0 ? { filters } : {}),
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
      if (store.ready) runner.run(request);
    },
    {
      site: () => site,
      key: () => request,
    },
  ),
);

const dayKey = $derived(localDayKey(timezone === undefined ? [] : [timezone], new Date(app.now)));
// Edit mode (docs/05): the editor is a code-split chunk, loaded on entry.
// svelte-ignore state_referenced_locally
const mode = createEditorMode(store, () => site);

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

/** Click-to-filter (docs/05): a repeated chip is a no-op, not a duplicate. */
function addFilter(filter: Filter): void {
  if (filters.some((existing) => sameFilter(existing, filter))) return;
  onfilters([...filters, filter]);
}

function removeFilter(index: number): void {
  onfilters(filters.filter((_, i) => i !== index));
}

const failed = $derived(runner.error !== undefined && runner.response !== undefined);
/** The range actually on screen — while refetching, the held response's, not the pill's. */
const heldRange = $derived.by<ViewRange>(() => {
  if (runner.held === undefined) return range;
  return 'preset' in runner.held.range ? runner.held.range.preset : runner.held.range;
});
/**
 * The window the SERVER resolved for the response on screen (`meta.windows`) —
 * so the label can never describe a different range from the data beside it, and
 * a page left open past this site's midnight moves both at once (the batch
 * re-runs on `dayKey`). The browser resolves no presets.
 */
const span = $derived(windowLabel(runner.response?.meta.windows));
/**
 * ONE environment for this page, handed to the dashboard AND to the editor's
 * preview — the preview used to be assembled from a shorter list of props, so
 * it rendered without the range qualifier, click-to-filter or the realtime jump.
 * It follows the range on SCREEN, not the pill, so a refetch cannot label held
 * data with the range being loaded.
 */
const env = $derived(dashboardEnv(app, { scope: site, range: heldRange, onfilter: addFilter }));
const note = $derived.by(() => {
  if (failed) {
    // A user-initiated change that never landed reads differently from a live
    // revalidation failure — and says what is actually on screen.
    return runner.stale
      ? `Couldn't load ${rangeQualifier(range)} — showing ${rangeQualifier(heldRange)}`
      : 'Live update failed — showing the last good result';
  }
  const compared = compareNote(heldRange, cmp) ?? 'no comparison';
  if (span === undefined) return compared.charAt(0).toUpperCase() + compared.slice(1);
  return `${span} · ${compared}`;
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
      {filters}
      {note}
      onselect={onselectrange}
      oncompare={onselectcmp}
      onremovefilter={removeFilter}
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
    layout={{ ...dashboard, site }}
    onclose={() => (ShareDialog = undefined)}
  />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .toolbar > :global(.filters) {
    flex: 1;
    min-width: 0;
  }

  .tool-btn {
    margin-top: 11px;
    flex-shrink: 0;
  }
</style>
