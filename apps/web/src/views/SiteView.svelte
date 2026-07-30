<script lang="ts">
import type { Filter, Query, QueryRequest } from '@featherstat/shared';
import { siteOverview } from '../dashboards/site-overview.ts';
import type { AdminClient } from '../lib/admin.ts';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import { createDashboardStore } from '../lib/dashboards.svelte.ts';
import { createEditorMode } from '../lib/editor-mode.svelte.ts';
import { sameFilter } from '../lib/filters.ts';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { localDayKey, RANGE_LABELS, type RangePreset } from '../lib/state.ts';
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
  site: number;
  /** The site's IANA timezone (site directory) — its midnight re-runs the batch. */
  timezone: string | undefined;
  range: RangePreset;
  filters: Filter[];
  onselectrange: (range: RangePreset) => void;
  /** Chips changed (row clicked, chip removed): one URL update, one re-batch. */
  onfilters: (filters: Filter[]) => void;
}

let { app, admin, client, live, site, timezone, range, filters, onselectrange, onfilters }: Props =
  $props();

// The clients are app-lifetime singletons; capturing their initial values is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);
// svelte-ignore state_referenced_locally
const store = createDashboardStore(admin);

// The stored dashboard for this site replaces the shipped default (docs/05).
$effect(() => {
  store.load(site);
});
const dashboard = $derived(store.stored ?? siteOverview);

/** This view's request shape — also the editor's preview context (batch of one widget). */
const requestFor = (queries: readonly Query[]): QueryRequest => ({
  site,
  range: { preset: range },
  compare: 'previous',
  ...(filters.length > 0 ? { filters } : {}),
  queries: withoutBlockedMetrics(hourlyWhenIntraday(queries, range), filters),
});

const request = $derived.by<QueryRequest>(() => requestFor(collectBatch(dashboard).queries));

// One batch per view state, held until the dashboard lookup answers (still ONE
// fetch — never a default-then-stored double batch); re-issued on state change …
$effect(() => {
  // The rollover is part of "view state": `today`/`mtd` are resolved
  // server-side, so their answer changes at this site's own midnight.
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

/**
 * Compare wording per preset (mockup: "compared with previous 30 days"). Only
 * `24h` is like-for-like: a partial period is compared against a complete one,
 * which is how a calendar range reads everywhere, and why the rolling preset
 * exists beside it (docs/04 § 3).
 */
const COMPARE_NOTE: Record<RangePreset, string> = {
  today: 'compared with all of yesterday',
  '24h': 'compared with the previous 24 hours',
  '7d': 'compared with the previous 7 days',
  '30d': 'compared with the previous 30 days',
  '90d': 'compared with the previous 90 days',
  mtd: 'compared with the previous period',
};

const failed = $derived(runner.error !== undefined && runner.response !== undefined);
/** The preset actually on screen — while refetching, the held response's, not the pill's. */
const heldRange = $derived(
  runner.held !== undefined && 'preset' in runner.held.range ? runner.held.range.preset : range,
);
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
      ? `Couldn't load ${RANGE_LABELS[range].toLowerCase()} — showing ${RANGE_LABELS[heldRange].toLowerCase()}`
      : 'Live update failed — showing the last good result';
  }
  if (span === undefined) return 'Compared with the previous period';
  return `${span} · ${COMPARE_NOTE[heldRange]}`;
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
    onsave={(next) => void mode.save(next)}
    oncancel={() => mode.close()}
  />
{:else}
  <div class="toolbar">
    <FilterRow
      {range}
      {filters}
      {note}
      onselect={onselectrange}
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
