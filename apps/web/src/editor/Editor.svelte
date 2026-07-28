<script lang="ts">
import {
  collectBatch,
  type Dashboard,
  dashboardBatchIssue,
  type Query,
  type QueryRequest,
  type QueryResponse,
  type SiteInfo,
  type WidgetSpec,
  widgetQueries,
} from '@analytics/shared';
import type { QueryClient } from '../lib/api.ts';
import { widgetData } from '../views/batch.ts';
import type { WidgetData } from '../widgets/types.ts';
import AddWidget from './AddWidget.svelte';
import EditorGrid from './EditorGrid.svelte';
import ExportImport from './ExportImport.svelte';
import {
  atWidgetCap,
  nextWidgetId,
  removeWidget,
  reorder,
  resizeWidget,
  updateWidget,
} from './model.ts';
import ShowQuery from './ShowQuery.svelte';
import WidgetSettings from './WidgetSettings.svelte';

/**
 * Edit mode (docs/05 § Widgets). The draft is a local copy of the dashboard;
 * the view's one batch keeps answering for unchanged widgets, while a widget
 * whose query changed (or was just added) previews with a batch of ONE
 * widget's queries — saving returns to the single view batch. Cancel discards
 * the draft; Save hands it back to the view, which persists it.
 */
interface Props {
  initial: Dashboard;
  client: QueryClient;
  /** The view's request builder — previews carry its exact range/filter context. */
  request: (queries: Query[]) => QueryRequest;
  response: QueryResponse | undefined;
  error: string | undefined;
  window?: { from: string; to: string };
  rangeLabel?: string;
  active?: Record<number, number>;
  sites?: ReadonlyMap<number, SiteInfo>;
  saving: boolean;
  saveError: string | undefined;
  onsave: (next: Dashboard) => void;
  oncancel: () => void;
}

let {
  initial,
  client,
  request,
  response,
  error,
  window,
  rangeLabel,
  active,
  sites,
  saving,
  saveError,
  onsave,
  oncancel,
}: Props = $props();

// The draft captures the dashboard at entry; the saved original keeps routing
// the view batch's answers. Both deliberately read `initial` once.
// svelte-ignore state_referenced_locally
let draft = $state<Dashboard>(structuredClone($state.snapshot(initial)));
// svelte-ignore state_referenced_locally
const saved = collectBatch(initial);
// svelte-ignore state_referenced_locally
const savedSpecs = new Map(initial.grid.map((spec) => [spec.id, JSON.stringify(spec)]));

/** Batch-of-one previews by widget id — they override the saved batch's answers. */
let previews = $state<Record<string, WidgetData>>({});
const controllers = new Map<string, AbortController>();

function preview(spec: WidgetSpec): void {
  controllers.get(spec.id)?.abort();
  const slots = widgetQueries(spec);
  const queries = Object.values(slots);
  if (queries.length === 0) {
    previews = Object.fromEntries(Object.entries(previews).filter(([id]) => id !== spec.id));
    return;
  }
  const controller = new AbortController();
  controllers.set(spec.id, controller);
  previews[spec.id] = { phase: 'loading', results: {} };
  client
    .query(request(queries), { signal: controller.signal })
    .then((answer) => {
      if (controller.signal.aborted) return;
      const results: WidgetData['results'] = {};
      for (const [slot, query] of Object.entries(slots)) results[slot] = answer.results[query.id];
      previews[spec.id] = { phase: 'ready', results };
    })
    .catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      previews[spec.id] = {
        phase: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
        results: {},
      };
    });
}

function dataFor(spec: WidgetSpec): WidgetData {
  return previews[spec.id] ?? widgetData(spec, saved.slots, response, error);
}

// ---- draft mutations (model.ts owns the logic; this owns the $state) ----

let adding = $state(false);
let jsonOpen = $state(false);
let settingsId = $state<string | undefined>(undefined);
let queryId = $state<string | undefined>(undefined);

const settingsSpec = $derived(draft.grid.find((spec) => spec.id === settingsId));
const querySpec = $derived(draft.grid.find((spec) => spec.id === queryId));

/** Widgets alone fit the cap, but their DERIVED queries can overflow the batch —
 * an unsaveable draft says why here instead of failing at the server. */
const batchIssue = $derived(dashboardBatchIssue($state.snapshot(draft)));

function handleAdd(spec: WidgetSpec): void {
  draft.grid = [...draft.grid, spec];
  adding = false;
  preview(spec);
}

function handleChange(next: WidgetSpec): void {
  const prev = draft.grid.find((spec) => spec.id === next.id);
  draft.grid = updateWidget(draft.grid, next);
  // Only a changed QUERY needs a fresh answer — title/sort edits render in place.
  if (
    prev !== undefined &&
    JSON.stringify(widgetQueries($state.snapshot(prev) as WidgetSpec)) !==
      JSON.stringify(widgetQueries(next))
  ) {
    preview(next);
  }
}

function handleRemove(id: string): void {
  controllers.get(id)?.abort();
  draft.grid = removeWidget(draft.grid, id);
  if (settingsId === id) settingsId = undefined;
  if (queryId === id) queryId = undefined;
}

/** An imported document replaces the draft; widgets the saved batch can't answer preview. */
function handleImport(dashboard: Dashboard): void {
  draft = structuredClone(dashboard);
  jsonOpen = false;
  previews = {};
  for (const spec of draft.grid) {
    if (savedSpecs.get(spec.id) !== JSON.stringify($state.snapshot(spec))) {
      preview($state.snapshot(spec) as WidgetSpec);
    }
  }
}
</script>

<div class="ebar">
  <span class="ebadge">Editing</span>
  <span class="ename">{draft.name}</span>
  {#if batchIssue !== undefined}<span class="form-error">{batchIssue}</span>
  {:else if saveError !== undefined}<span class="form-error">{saveError}</span>{/if}
  <span class="spacer"></span>
  <button
    class="btn"
    type="button"
    disabled={atWidgetCap(draft)}
    title={atWidgetCap(draft) ? 'This dashboard is at the widget cap' : undefined}
    onclick={() => (adding = true)}>Add widget</button
  >
  <button class="btn" type="button" onclick={() => (jsonOpen = true)}>JSON</button>
  <button class="btn" type="button" onclick={oncancel}>Cancel</button>
  <button
    class="btn primary"
    type="button"
    disabled={saving || batchIssue !== undefined}
    title={batchIssue}
    onclick={() => onsave($state.snapshot(draft))}>{saving ? 'Saving…' : 'Save'}</button
  >
</div>

<EditorGrid
  grid={draft.grid}
  {dataFor}
  {window}
  {rangeLabel}
  {active}
  {sites}
  onreorder={(from, to) => (draft.grid = reorder(draft.grid, from, to))}
  onresize={(id, w) => (draft.grid = resizeWidget(draft.grid, id, w))}
  onremove={handleRemove}
  onsettings={(id) => (settingsId = id)}
  onquery={(id) => (queryId = id)}
/>

{#if adding}
  <AddWidget
    id={nextWidgetId(draft.grid)}
    site={draft.site}
    onadd={handleAdd}
    onclose={() => (adding = false)}
  />
{/if}
{#if jsonOpen}
  <ExportImport
    draft={$state.snapshot(draft)}
    onapply={handleImport}
    onclose={() => (jsonOpen = false)}
  />
{/if}
{#if settingsSpec !== undefined}
  <WidgetSettings
    spec={$state.snapshot(settingsSpec) as WidgetSpec}
    onchange={handleChange}
    onclose={() => (settingsId = undefined)}
  />
{/if}
{#if querySpec !== undefined}
  <ShowQuery
    spec={$state.snapshot(querySpec) as WidgetSpec}
    data={dataFor(querySpec)}
    onclose={() => (queryId = undefined)}
  />
{/if}

<style>
  .ebar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 12px 0 14px;
  }

  .ebadge {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--s1);
    border: 1px solid color-mix(in srgb, var(--s1) 40%, transparent);
    background: color-mix(in srgb, var(--s1) 10%, transparent);
    border-radius: 99px;
    padding: 3px 10px;
  }

  .ename {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
