<script lang="ts">
/**
 * The mockup's sparkline, both variants: plain (line in the de-emphasis hue,
 * accent end dot — KPI tiles) and accent (series-1 line over a 10% area wash —
 * site cards). `stretch` scales it to the container like the mockup's
 * `.site-card svg { width: 100% }`.
 */
interface Props {
  data: readonly number[];
  width: number;
  height: number;
  accent?: boolean;
  stretch?: boolean;
}

let { data, width, height, accent = false, stretch = false }: Props = $props();

const PAD = 3;

const geometry = $derived.by(() => {
  if (data.length === 0) return undefined;
  const points = data.length === 1 ? [data[0] ?? 0, data[0] ?? 0] : [...data];
  const max = Math.max(...points);
  const min = Math.min(...points);
  const coords = points.map(
    (value, i) =>
      [
        PAD + (i * (width - 2 * PAD)) / (points.length - 1),
        height - PAD - ((value - min) / (max - min || 1)) * (height - 2 * PAD),
      ] as const,
  );
  const end = coords[coords.length - 1];
  if (end === undefined) return undefined;
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${PAD},${height - PAD} ${line} ${(width - PAD).toFixed(1)},${height - PAD}`;
  return { line, area, end };
});
</script>

{#if geometry !== undefined}
  <svg
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    aria-hidden="true"
    style={stretch ? 'width: 100%; height: auto;' : undefined}
  >
    {#if accent}<polygon points={geometry.area} class="wash" />{/if}
    <polyline points={geometry.line} class="line" class:accent />
    <circle cx={geometry.end[0].toFixed(1)} cy={geometry.end[1].toFixed(1)} r="3.5" class="dot" />
  </svg>
{/if}

<style>
  svg {
    display: block;
  }

  .wash {
    fill: var(--s1);
    opacity: 0.1;
  }

  .line {
    fill: none;
    stroke: var(--axis);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .line.accent {
    stroke: var(--s1);
  }

  .dot {
    fill: var(--s1);
    stroke: var(--surface);
    stroke-width: 2;
  }
</style>
