<script lang="ts">
/**
 * The mockup's sparkline, both variants: plain (line in the de-emphasis hue,
 * accent end dot — KPI tiles) and micro (hairline, no dot — the per-page trend
 * inside a site card). A chart worth reading closely is a `LineChart`.
 *
 * A point may be `undefined`: the period it covers had nothing to measure. A
 * bounce rate over an hour with no visits is unknown, not zero, and hourly
 * buckets on a quiet site produce plenty of those. The line BREAKS across such
 * a run rather than bridging it, because a segment drawn straight through a gap
 * claims a trend nobody measured. A series with no measured point at all draws
 * nothing — that is a measure this companion cannot reduce, not a quiet period.
 */
interface Props {
  data: readonly (number | undefined)[];
  width: number;
  height: number;
  micro?: boolean;
}

let { data, width, height, micro = false }: Props = $props();

const PAD = 3;

const geometry = $derived.by(() => {
  const measured = data.filter((value): value is number => value !== undefined);
  if (measured.length === 0) return undefined;
  const points = data.length === 1 ? [measured[0], measured[0]] : [...data];
  // An unlabeled axis must start at zero, or the smallest value reads as nothing.
  const max = Math.max(0, ...measured);
  const min = Math.min(0, ...measured);
  const span = max - min || 1;
  const xOf = (i: number): number => PAD + (i * (width - 2 * PAD)) / (points.length - 1);
  const yOf = (value: number): number => height - PAD - ((value - min) / span) * (height - 2 * PAD);

  const segments: string[] = [];
  let run: string[] = [];
  let end: readonly [number, number] | undefined;
  const close = (): void => {
    if (run.length === 0) return;
    // A lone measured point between two gaps is a zero-length segment, which a
    // round cap renders as a dot — visible, where a one-point polyline is not.
    segments.push(run.length === 1 ? `${run[0]} ${run[0]}` : run.join(' '));
    run = [];
  };
  points.forEach((value, i) => {
    if (value === undefined) {
      close();
      return;
    }
    const x = xOf(i);
    const y = yOf(value);
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    end = [x, y];
  });
  close();
  if (end === undefined) return undefined;
  return { segments, end };
});
</script>

{#if geometry !== undefined}
  <svg {width} {height} viewBox="0 0 {width} {height}" aria-hidden="true">
    {#each geometry.segments as segment, i (i)}
      <polyline points={segment} class="line" class:micro />
    {/each}
    {#if !micro}
      <circle cx={geometry.end[0].toFixed(1)} cy={geometry.end[1].toFixed(1)} r="3.5" class="dot" />
    {/if}
  </svg>
{/if}

<style>
  svg {
    display: block;
  }

  .line {
    fill: none;
    /* --muted, not the mockup's --axis: non-text graphics need >= 3:1 on
       --surface in both themes (WCAG 1.4.11); --axis measures ~1.5–1.8:1. */
    stroke: var(--muted);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .line.micro {
    stroke-width: 1.5;
  }

  .dot {
    fill: var(--s1);
    stroke: var(--surface);
    stroke-width: 2;
  }
</style>
