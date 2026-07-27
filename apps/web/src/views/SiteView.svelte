<script lang="ts">
import type { QueryRequest } from '@analytics/shared';
import { siteOverview } from '../dashboards/site-overview.ts';
import type { QueryClient } from '../lib/api.ts';
import FilterRow from '../lib/components/FilterRow.svelte';
import { createRevalidator, type LiveStream } from '../lib/live.ts';
import { RANGE_LABELS, type RangePreset } from '../lib/state.ts';
import { bucketedWindow, bucketLabel } from '../widgets/format.ts';
import { createBatchRunner } from './batch.svelte.ts';
import { collectBatch, hourlyWhenToday } from './batch.ts';
import DashboardGrid from './DashboardGrid.svelte';

interface Props {
  client: QueryClient;
  live: LiveStream;
  site: number;
  range: RangePreset;
  onselectrange: (range: RangePreset) => void;
}

let { client, live, site, range, onselectrange }: Props = $props();

const { queries } = collectBatch(siteOverview);
// The client is an app-lifetime singleton; capturing its initial value is the point.
// svelte-ignore state_referenced_locally
const runner = createBatchRunner(client);

const request = $derived<QueryRequest>({
  site,
  range: { preset: range },
  compare: 'previous',
  queries: hourlyWhenToday(queries, range),
});

// One batch per view state; re-issued when the URL-driven state changes …
$effect(() => {
  runner.run(request);
});
// … and when debounced version ticks say this site's data moved (docs/05 R22).
// The key voids a window armed for a state the user has since left: that state
// change ran its own batch, and the timer must not re-issue (and abort) it.
$effect(() =>
  createRevalidator(live, () => runner.run(request), {
    site: () => site,
    key: () => request,
  }),
);

/** Compare wording per preset (mockup: "compared with previous 30 days"). */
const COMPARE_NOTE: Record<RangePreset, string> = {
  today: 'compared with yesterday',
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
const note = $derived.by(() => {
  if (failed) {
    // A user-initiated change that never landed reads differently from a live
    // revalidation failure — and says what is actually on screen.
    return runner.stale
      ? `Couldn't load ${RANGE_LABELS[range].toLowerCase()} — showing ${RANGE_LABELS[heldRange].toLowerCase()}`
      : 'Live update failed — showing the last good result';
  }
  const window = bucketedWindow(runner.response);
  if (window === undefined) return 'Compared with the previous period';
  const span =
    window.from === window.to
      ? bucketLabel(window.from)
      : `${bucketLabel(window.from)} – ${bucketLabel(window.to)}`;
  return `${span} · ${COMPARE_NOTE[heldRange]}`;
});
</script>

<FilterRow
  {range}
  {note}
  onselect={onselectrange}
  onretry={runner.error === undefined ? undefined : () => runner.retry()}
/>
<DashboardGrid
  dashboard={siteOverview}
  response={runner.response}
  error={runner.error}
  refetching={runner.refetching}
/>
