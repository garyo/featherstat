<script lang="ts">
import { elapsedThrough } from '@featherstat/shared';
import { resultAxes, sharedKeys } from './axis.ts';
import { metricLabel } from './format.ts';
import LineChart from './LineChart.svelte';
import { SERIES_COLORS, seriesOf } from './series.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, env }: WidgetProps = $props();

/** docs/05 caps shared-axis charts at 4 series; the walking skeleton draws 2. */
const MAX_SERIES = 2;

const slice = $derived(sliceOf(env.data, 'main'));
// Deduped: the schema permits repeats, and duplicate {#each} keys throw at runtime.
const metrics = $derived(
  spec.query !== undefined && !('kind' in spec.query)
    ? [...new Set(spec.query.metrics)].slice(0, MAX_SERIES)
    : [],
);
// The x axis is the server's, moved to the reader's clock — one shared axis even
// when the batch spans timezones (widgets/axis.ts).
const axis = $derived(
  slice.kind === 'ready' ? sharedKeys(resultAxes(slice.result, env.windows ?? [], env.now)) : [],
);
const points = $derived(slice.kind === 'ready' ? seriesOf(slice.result.rows, metrics, axis) : []);

/**
 * Annotation markers (docs/05 § Annotations): the notes the batch opted in to
 * (`meta.annotations`), placed on the bucket their instant falls in — the same
 * clock→bucket derivation the axis trim uses, in the site's own timezone. Keyed
 * by point index; the texts join the hover tooltip.
 */
const noted = $derived.by(() => {
  const map = new Map<number, string[]>();
  const bucket = slice.kind === 'ready' ? slice.result.bucket : undefined;
  if (env.annotations === null || bucket === undefined) return map;
  const zones = new Map((env.windows ?? []).map((w) => [w.siteId, w.timezone]));
  const fallback = env.windows?.[0]?.timezone ?? 'UTC';
  const index = new Map(points.map((point, i) => [point.bucket, i]));
  for (const ann of env.annotations) {
    if (typeof env.scope === 'number' && ann.siteId !== null && ann.siteId !== env.scope) continue;
    const zone = (ann.siteId === null ? undefined : zones.get(ann.siteId)) ?? fallback;
    const at = index.get(elapsedThrough(bucket, zone, ann.ts));
    if (at === undefined) continue;
    map.set(at, [...(map.get(at) ?? []), ann.text]);
  }
  return map;
});

const title = $derived(spec.title ?? metrics.map((m) => metricLabel(m)).join(' and '));
</script>

<div class="card-head">
  <h2>{spec.title ?? 'Time series'}</h2>
  {#if metrics.length >= 2}
    <div class="legend">
      {#each metrics as metric, i (metric)}
        <span class="key">
          <span class="line" style="border-color: {SERIES_COLORS[i]};"></span>{metricLabel(metric)}
        </span>
      {/each}
    </div>
  {/if}
</div>

<div class="chart-wrap">
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if points.length === 0}
    <p class="widget-note">No data in this range.</p>
  {:else}
    <LineChart {points} {metrics} label={title} notes={noted} />
  {/if}
</div>
