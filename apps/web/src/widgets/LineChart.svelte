<script lang="ts">
/**
 * A time series as a real chart: zero-based y-axis with labeled ticks, bucket
 * labels along x, and the crosshair + all-series tooltip (docs/05 § Hover
 * layer). The one owner of that plot — `Timeseries` draws it full size, a site
 * card draws it compact.
 *
 * `nested` is for a chart inside another control (a site card is one button):
 * a control's content is presentational, so the chart takes no focus stop,
 * carries no table and is hidden from assistive tech — the pointer still gets
 * the crosshair, and the view the control opens has the full chart.
 */
import type { MetricQuery } from '@featherstat/shared';
import { keyStep } from '../lib/keys.ts';
import DataTable from './DataTable.svelte';
import { bucketLabel, bucketTitle, exactNumber, metricLabel } from './format.ts';
import { num, SERIES_COLORS, type SeriesPoint } from './series.ts';

interface Props {
  points: readonly SeriesPoint[];
  metrics: readonly MetricQuery['metrics'][number][];
  /** What the chart shows — its accessible name and its table's caption. */
  label: string;
  height?: number;
  /** Gridlines above the zero line. */
  divisions?: number;
  /** Annotation texts by point index; a marker on the plot, a line in the tooltip. */
  notes?: ReadonlyMap<number, readonly string[]>;
  nested?: boolean;
}

let {
  points,
  metrics,
  label,
  height = 250,
  divisions = 4,
  notes = new Map(),
  nested = false,
}: Props = $props();

const MARGIN = { l: 42, r: 14, t: 10, b: 26 };

let width = $state(0);
let svgEl: SVGSVGElement | undefined = $state();
let hover = $state<number | undefined>();

const geom = $derived.by(() => {
  const n = points.length;
  if (n === 0 || width < MARGIN.l + MARGIN.r + 40) return undefined;
  const iw = width - MARGIN.l - MARGIN.r;
  const ih = height - MARGIN.t - MARGIN.b;
  const dataMax = Math.max(
    1,
    ...points.flatMap((point) => metrics.map((metric) => num(point.values[metric]))),
  );
  const maxY = niceMax(dataMax, divisions);
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
    ticks: Array.from({ length: divisions + 1 }, (_, k) => (maxY / divisions) * k),
    labelStep: Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 140)))),
    paths,
    area: `${x(0).toFixed(1)},${y(0).toFixed(1)} ${paths[0] ?? ''} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`,
  };
});

/** Smallest 1/2/5-step scale whose divisions cover the data — whole-number ticks. */
function niceMax(value: number, steps: number): number {
  if (value <= steps) return steps;
  const magnitude = 10 ** Math.floor(Math.log10(value / steps));
  for (const unit of [1, 2, 5, 10]) {
    const step = unit * magnitude;
    if (step * steps >= value) return step * steps;
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

/** The keyboard's crosshair: arrows step a bucket, Home/End jump to the ends. */
function onKeydown(event: KeyboardEvent): void {
  const next = keyStep(event.key, hover ?? points.length - 1, points.length);
  if (next === undefined) return;
  event.preventDefault();
  hover = next;
}

/** One bucket as a sentence — what the keyboard's crosshair announces. */
function pointText(i: number): string {
  const point = points[i];
  if (point === undefined) return '';
  const values = metrics.map(
    (metric) => `${exactNumber(num(point.values[metric]))} ${metricLabel(metric).toLowerCase()}`,
  );
  return `${bucketTitle(point.bucket)}: ${values.join(', ')}`;
}

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

<div class="line-chart" style="min-height: {height}px;" bind:clientWidth={width}>
  {#if geom !== undefined}
    <!-- Focusable, stepping bucket by bucket (docs/05 § Accessibility: every
         mark reachable, with the same tooltip a pointer gets); the exact
         values are also in the table below it. Nested, it is hidden from
         assistive tech: the control around it says what it shows. -->
    <svg
      bind:this={svgEl}
      {width}
      {height}
      viewBox="0 0 {width} {height}"
      class="plot"
      role="slider"
      aria-hidden={nested ? 'true' : undefined}
      tabindex={nested ? undefined : 0}
      aria-label={nested ? undefined : `${label}, per bucket`}
      aria-valuemin={nested ? undefined : 0}
      aria-valuemax={nested ? undefined : geom.n - 1}
      aria-valuenow={nested ? undefined : (hover ?? geom.n - 1)}
      aria-valuetext={nested ? undefined : pointText(hover ?? geom.n - 1)}
      onkeydown={onKeydown}
      onfocus={() => (hover ??= geom === undefined ? undefined : geom.n - 1)}
      onblur={() => (hover = undefined)}
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
          <text x={geom.x(i)} y={height - 8} text-anchor="middle" class="tick">
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
      {#each [...notes.keys()] as i (i)}
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
        {#each notes.get(hover ?? -1) ?? [] as text, n (n)}
          <div class="tip-full">◦ {text}</div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
{#if !nested && points.length > 0}
  <DataTable
    caption="{label} — exact values per bucket"
    head={['Bucket', ...metrics.map((metric) => metricLabel(metric)), ...(notes.size > 0 ? ['Notes'] : [])]}
    rows={points.map((point, i) => ({
      key: point.bucket,
      label: bucketTitle(point.bucket),
      cells: [
        ...metrics.map((metric) => exactNumber(num(point.values[metric]))),
        ...(notes.size > 0 ? [(notes.get(i) ?? []).join('; ')] : []),
      ],
    }))}
  />
{/if}

<style>
  .line-chart {
    position: relative;
  }

  .line-chart svg {
    display: block;
  }

  .plot:focus-visible {
    outline: 2px solid var(--s1);
    outline-offset: 2px;
    border-radius: 4px;
  }

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
