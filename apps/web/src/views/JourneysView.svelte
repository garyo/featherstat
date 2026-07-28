<script lang="ts">
import type { Filter, QueryRequest } from '@featherstat/shared';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { RANGE_LABELS, type RangePreset } from '../lib/state.ts';
import FlowsTable from '../widgets/FlowsTable.svelte';
import type { EdgeRef } from '../widgets/flows.ts';
import { bucketLabel, presetWindow } from '../widgets/format.ts';
import Sankey from '../widgets/Sankey.svelte';
import { sliceOf, type WidgetData } from '../widgets/types.ts';
import { createBatchRunner } from './batch.svelte.ts';

/**
 * The per-site Journeys view (docs/05 R21): a sankey of the first N steps from
 * the entry page over the top-journeys table. Both widgets ride ONE
 * `/api/query` batch per view state (CLAUDE.md invariant 1) — transitions +
 * flows together — and the view honors the global filter row and range, so
 * "journeys of visitors from HN" is one click.
 */
interface Props {
  client: QueryClient;
  live: LiveStream;
  site: number;
  /** The site's IANA timezone (site directory) — resolves the window label. */
  timezone: string | undefined;
  range: RangePreset;
  filters: Filter[];
  onselectrange: (range: RangePreset) => void;
  onfilters: (filters: Filter[]) => void;
}

let { client, live, site, timezone, range, filters, onselectrange, onfilters }: Props = $props();

/** Toolbar depths: `depth` columns = entry + depth-1 transition hops. */
const DEPTHS = [3, 4, 5] as const;
let depth = $state<(typeof DEPTHS)[number]>(4);

// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

const request = $derived.by<QueryRequest>(() => ({
  site,
  range: { preset: range },
  ...(filters.length > 0 ? { filters } : {}),
  // depth-1 hops draw depth columns, and depth-long signatures mean every
  // sankey edge lands inside a table signature — the click filter's contract.
  queries: [
    { id: 'sankey', kind: 'transitions', steps: depth - 1, limit: 20 },
    { id: 'flows', kind: 'flows', steps: depth, limit: 20 },
  ],
}));

// One batch per view state; re-issued when the URL-driven state (or depth) changes …
$effect(() => {
  runner.run(request);
});
// … and when debounced version ticks say this site's data moved (docs/05 R22).
$effect(() =>
  createRevalidator(live, () => runner.run(request), {
    site: () => site,
    key: () => request,
  }),
);

/** A clicked sankey edge narrows the table below — client-side (flows.ts). */
let selected = $state<EdgeRef | undefined>();
// A new answer describes different journeys; a held selection would filter the
// table by an edge the sankey may no longer show.
$effect(() => {
  void request;
  selected = undefined;
});

const data = $derived<WidgetData>(
  runner.response === undefined
    ? {
        phase: runner.error === undefined ? 'loading' : 'error',
        message: runner.error,
        results: {},
      }
    : {
        phase: 'ready',
        results: { sankey: runner.response.results.sankey, flows: runner.response.results.flows },
      },
);
/** The compiler's per-query refusal is correct but developer-voiced; the person
 * looking at this card needs the way out, not the vocabulary rule. */
const EVENT_FILTER_REFUSAL = /event-level filter '([^']+)'/;
function friendly(slice: ReturnType<typeof sliceOf>): ReturnType<typeof sliceOf> {
  if (slice.kind !== 'error') return slice;
  const match = EVENT_FILTER_REFUSAL.exec(slice.message);
  if (match === null) return slice;
  return {
    kind: 'error',
    message: `Journeys can't filter by “${match[1]}” — remove that chip to see journeys.`,
  };
}

const sankeySlice = $derived(friendly(sliceOf(data, 'sankey')));
const flowsSlice = $derived(friendly(sliceOf(data, 'flows')));

function removeFilter(index: number): void {
  onfilters(filters.filter((_, i) => i !== index));
}

const failed = $derived(runner.error !== undefined && runner.response !== undefined);
/** The preset actually on screen — while refetching, the held response's, not the pill's. */
const heldRange = $derived(
  runner.held !== undefined && 'preset' in runner.held.range ? runner.held.range.preset : range,
);
const window = $derived(timezone !== undefined ? presetWindow(heldRange, timezone) : undefined);
const note = $derived.by(() => {
  if (failed) {
    return runner.stale
      ? `Couldn't load ${RANGE_LABELS[range].toLowerCase()} — showing ${RANGE_LABELS[heldRange].toLowerCase()}`
      : 'Live update failed — showing the last good result';
  }
  if (window === undefined) return undefined;
  return window.from === window.to
    ? bucketLabel(window.from)
    : `${bucketLabel(window.from)} – ${bucketLabel(window.to)}`;
});
</script>

<div class="toolbar">
  <FilterRow
    {range}
    {filters}
    {note}
    onselect={onselectrange}
    onremovefilter={removeFilter}
    onretry={runner.error === undefined ? undefined : () => runner.retry()}
  />
  <div class="depth" role="group" aria-label="Journey depth">
    <span class="depth-label">Steps</span>
    {#each DEPTHS as d (d)}
      <button class="preset" type="button" aria-pressed={depth === d} onclick={() => (depth = d)}
        >{d}</button
      >
    {/each}
  </div>
</div>

<div class="grid" class:refetching={runner.refetching}>
  <div class="card">
    <h2>Journeys from the entry page</h2>
    <Sankey slice={sankeySlice} {depth} {selected} onselect={(edge) => (selected = edge)} />
  </div>
  <div class="card">
    <h2>Top journeys</h2>
    <FlowsTable slice={flowsSlice} steps={depth} {selected} onclear={() => (selected = undefined)} />
  </div>
</div>

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

  .depth {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 14px 0;
  }

  .depth-label {
    color: var(--muted);
    font-size: 13px;
    margin-right: 4px;
  }

  /* The refetch hold (docs/05): previous render stays, dimmed — never a skeleton. */
  .grid {
    transition: opacity 0.15s linear;
  }

  .grid.refetching {
    opacity: 0.6;
  }
</style>
