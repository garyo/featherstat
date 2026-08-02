<script lang="ts">
import { elapsedThrough } from '@featherstat/shared';
import { resultAxes, sharedKeys } from './axis.ts';
import { bucketLabel, bucketTitle, exactNumber, metricLabel } from './format.ts';
import { num, seriesOf } from './series.ts';
import { sliceOf, type WidgetProps } from './types.ts';

let { spec, env }: WidgetProps = $props();

const HEIGHT = 250;
const MARGIN = { l: 42, r: 14, t: 10, b: 26 };
/** docs/05 caps shared-axis charts at 4 series; the walking skeleton draws 2. */
const MAX_SERIES = 2;
/** Categorical slots in fixed order, assigned by position, never cycled. */
const SERIES_COLORS = ['var(--s1)', 'var(--s2)'];

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
 * by point index; the texts join the existing hover tooltip.
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

let width = $state(0);
let svgEl: SVGSVGElement | undefined = $state();
let hover = $state<number | undefined>();

const geom = $derived.by(() => {
  const n = points.length;
  if (n === 0 || width < MARGIN.l + MARGIN.r + 40) return undefined;
  const iw = width - MARGIN.l - MARGIN.r;
  const ih = HEIGHT - MARGIN.t - MARGIN.b;
  const dataMax = Math.max(
    1,
    ...points.flatMap((point) => metrics.map((metric) => num(point.values[metric]))),
  );
  const maxY = niceMax(dataMax);
  const x = (i: number): number => MARGIN.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (value: number): number => MARGIN.t + ih - (value / maxY) * ih;
  const paths = metrics.map((metric) =>
    points
      .map((point, i) => `${x(i).toFixed(1)},${y(num(point.values[metric])).toFixed(1)}`)
      .join(' '),
  );
  return {
    n,
    iw,
    ih,
    x,
    y,
    ticks: [0, 1, 2, 3, 4].map((k) => (maxY / 4) * k),
    labelStep: Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 140)))),
    paths,
    area: `${x(0).toFixed(1)},${y(0).toFixed(1)} ${paths[0] ?? ''} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`,
  };
});

/** Smallest 1/2/5-step scale whose four divisions cover the data — clean ticks. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value / 4));
  for (const unit of [1, 2, 5, 10]) {
    const step = unit * magnitude;
    if (step * 4 >= value) return step * 4;
  }
  return value;
}

function onPointerMove(event: PointerEvent): void {
  if (geom === undefined || svgEl === undefined) return;
  const rect = svgEl.getBoundingClientRect();
  const ratio = (event.clientX - rect.left - MARGIN.l) / Math.max(1, geom.iw);
  hover = Math.max(0, Math.min(geom.n - 1, Math.round(ratio * (geom.n - 1))));
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

const hoverPoint = $derived(hover === undefined ? undefined : points[hover]);

// Measured, so wide values clamp correctly and the flip below knows its height.
let tipW = $state(0);
let tipH = $state(0);

/**
 * Anchored to the top of the plot, but flipped to the bottom when the hovered
 * peak reaches the top third — the tooltip must never sit on the value it names.
 */
const tipPos = $derived.by(() => {
  if (hover === undefined || hoverPoint === undefined || geom === undefined) return undefined;
  const half = Math.max(tipW / 2, 40) + 4;
  const left = clamp(geom.x(hover), half, Math.max(half, width - half));
  const peakY = Math.min(...metrics.map((metric) => geom.y(num(hoverPoint.values[metric]))));
  const top =
    peakY < MARGIN.t + geom.ih / 3
      ? Math.max(MARGIN.t + 6, MARGIN.t + geom.ih - tipH - 6)
      : MARGIN.t + 6;
  return { left, top };
});
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

<div class="chart-wrap" bind:clientWidth={width}>
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if points.length === 0}
    <p class="widget-note">No data in this range.</p>
  {:else if geom !== undefined}
    <svg
      bind:this={svgEl}
      {width}
      height={HEIGHT}
      viewBox="0 0 {width} {HEIGHT}"
      role="img"
      aria-label="{spec.title ?? metrics.map((m) => metricLabel(m)).join(' and ')}, per bucket"
    >
      {#each geom.ticks as tick (tick)}
        <line
          x1={MARGIN.l}
          y1={geom.y(tick)}
          x2={width - MARGIN.r}
          y2={geom.y(tick)}
          class={tick === 0 ? 'axisline' : 'gridline'}
        />
        <text x={MARGIN.l - 8} y={geom.y(tick) + 4} text-anchor="end" class="tick">
          {exactNumber(tick)}
        </text>
      {/each}
      {#each points as point, i (point.bucket)}
        {#if i % geom.labelStep === 0 && geom.x(i) < width - 24}
          <text x={geom.x(i)} y={HEIGHT - 8} text-anchor="middle" class="tick">
            {bucketLabel(point.bucket)}
          </text>
        {/if}
      {/each}
      <polygon points={geom.area} class="area" />
      {#each metrics as metric, i (metric)}
        {@const si = metrics.length - 1 - i}
        <polyline
          points={geom.paths[si] ?? ''}
          class="series"
          style="stroke: {SERIES_COLORS[si]};"
        />
      {/each}
      {#each [...noted.keys()] as i (i)}
        <circle class="ann-mark" cx={geom.x(i)} cy={MARGIN.t + 4} r="3.5" />
      {/each}
      {#if hover !== undefined && hover < geom.n}
        <g class="xhair">
          <line x1={geom.x(hover)} x2={geom.x(hover)} y1={MARGIN.t} y2={MARGIN.t + geom.ih} />
          {#each metrics as metric, i (metric)}
            <circle
              cx={geom.x(hover)}
              cy={geom.y(num(points[hover]?.values[metric]))}
              r="4"
              style="fill: {SERIES_COLORS[i]};"
            />
          {/each}
        </g>
      {/if}
      <!-- Generous hover hit target: the whole plot area, snapping to the nearest bucket. -->
      <rect
        role="presentation"
        x={MARGIN.l}
        y={MARGIN.t}
        width={geom.iw}
        height={geom.ih}
        fill="transparent"
        onpointermove={onPointerMove}
        onpointerleave={() => (hover = undefined)}
      />
    </svg>
    {#if hoverPoint !== undefined && tipPos !== undefined}
      <div
        class="chart-tip"
        bind:clientWidth={tipW}
        bind:clientHeight={tipH}
        style="left: {tipPos.left}px; top: {tipPos.top}px;"
      >
        <div class="tip-title">{bucketTitle(hoverPoint.bucket)}</div>
        {#each metrics as metric, i (metric)}
          <div class="tip-row">
            <span class="tip-key" style="border-color: {SERIES_COLORS[i]};"></span>
            <span class="tip-val">{exactNumber(num(hoverPoint.values[metric]))}</span>
            <span class="tip-name">{metricLabel(metric).toLowerCase()}</span>
          </div>
        {/each}
        {#each noted.get(hover ?? -1) ?? [] as text, n (n)}
          <div class="tip-full">◦ {text}</div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .gridline {
    stroke: var(--grid);
    stroke-width: 1;
  }

  .axisline {
    stroke: var(--axis);
    stroke-width: 1;
  }

  .tick {
    fill: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .area {
    fill: var(--s1);
    opacity: 0.1;
  }

  .series {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .xhair line {
    stroke: var(--axis);
    stroke-width: 1;
  }

  .xhair circle {
    stroke: var(--surface);
    stroke-width: 2;
  }

  .ann-mark {
    fill: var(--s2);
    stroke: var(--surface);
    stroke-width: 1.5;
  }
</style>
