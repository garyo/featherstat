<script lang="ts">
import { type EdgeRef, journeyStep, percent } from './flows.ts';
import { exactNumber } from './format.ts';
import {
  buildSankey,
  columnTitle,
  type SankeyLink,
  type SankeyNode,
  transitionEdges,
} from './sankey.ts';
import type { Slice } from './types.ts';

/**
 * Hand-rolled SVG sankey of a transitions result (docs/05 R21): columns by
 * step depth from the entry page, ribbons ∝ sessions in sequential blue washes
 * (magnitude, never identity), node labels in ink, event nodes wearing the
 * orange dot. All labels are visitor-controlled strings — text interpolation
 * only (registry.ts security boundary).
 */
interface Props {
  slice: Slice;
  /** Column count — the toolbar's depth selection. */
  depth: number;
  selected: EdgeRef | undefined;
  /** Toggles the flows table's edge filter; a fold-touching link never filters. */
  onselect: (edge: EdgeRef | undefined) => void;
}

let { slice, depth, selected, onselect }: Props = $props();

const PLOT_H = 300;
/** Column titles row inside the svg, above the plot. */
const HEADER_H = 20;
const HEIGHT = PLOT_H + HEADER_H;
const NODE_W = 8;
const PAD = 2;
const LABEL_GAP = 6;
/** The event dot's edge length, matching the table's `.evt-dot`. */
const DOT = 7;
/** Below this, adjacent columns' labels collide — the svg keeps this width and
 * scrolls inside its own pane instead (docs/05 responsive). */
const MIN_PLOT_W = 480;

let width = $state(0);
let pane: HTMLDivElement | undefined = $state();

const edges = $derived(slice.kind === 'ready' ? transitionEdges(slice.result.rows) : []);
const layout = $derived(buildSankey(edges, depth, PLOT_H));
const cols = $derived(layout.columns.length);

const plotWidth = $derived(Math.max(width, MIN_PLOT_W));

const colX = (column: number): number =>
  PAD + (column * (plotWidth - 2 * PAD - NODE_W)) / Math.max(1, cols - 1);

/** Room for a label beside its node before it runs into the next column. */
const maxLabelChars = $derived(
  Math.max(8, Math.floor(((plotWidth - 2 * PAD - NODE_W) / Math.max(1, cols - 1) - 24) / 6.2)),
);

const displayText = (label: string, other: boolean): string =>
  other ? 'Other' : journeyStep(label).text;

function nodeText(node: SankeyNode): string {
  const text = displayText(node.label, node.other);
  return text.length > maxLabelChars ? `${text.slice(0, maxLabelChars - 1)}…` : text;
}

function ribbon(link: SankeyLink): string {
  const x0 = colX(link.step - 1) + NODE_W;
  const x1 = colX(link.step);
  const xm = ((x0 + x1) / 2).toFixed(1);
  const sy0 = (link.sy0 + HEADER_H).toFixed(1);
  const sy1 = (link.sy0 + HEADER_H + link.thickness).toFixed(1);
  const ty0 = (link.ty0 + HEADER_H).toFixed(1);
  const ty1 = (link.ty0 + HEADER_H + link.thickness).toFixed(1);
  return `M ${x0} ${sy0} C ${xm} ${sy0}, ${xm} ${ty0}, ${x1} ${ty0} L ${x1} ${ty1} C ${xm} ${ty1}, ${xm} ${sy1}, ${x0} ${sy1} Z`;
}

/** Only a fully named edge can honestly filter the table below. */
const filterable = (link: SankeyLink): boolean => !link.fromOther && !link.toOther;

const isSelected = (link: SankeyLink): boolean =>
  selected !== undefined &&
  filterable(link) &&
  selected.step === link.step &&
  selected.from === link.from &&
  selected.to === link.to;

function toggle(link: SankeyLink): void {
  onselect(
    isSelected(link)
      ? undefined
      : { step: link.step, from: link.from, to: link.to, sessions: link.sessions },
  );
}

function onKeydown(event: KeyboardEvent, link: SankeyLink): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggle(link);
  }
}

/** docs/05: per-mark tooltips from the shared hover layer, values leading. */
let tip = $state<{ link: SankeyLink; x: number; y: number } | undefined>();

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

function showTip(link: SankeyLink, event: PointerEvent): void {
  if (pane === undefined) return;
  const rect = pane.getBoundingClientRect();
  tip = {
    link,
    x: clamp(event.clientX - rect.left, 70, Math.max(70, rect.width - 70)),
    y: Math.max(56, event.clientY - rect.top - 12),
  };
}

/** Keyboard focus anchors the tooltip at the ribbon's source end. */
function focusTip(link: SankeyLink): void {
  tip = {
    link,
    x: clamp(colX(link.step - 1) + NODE_W + 40, 70, Math.max(70, plotWidth - 70)),
    y: Math.max(56, link.sy0 + HEADER_H),
  };
}

const linkTitle = (link: SankeyLink): string =>
  `${displayText(link.from, link.fromOther)} → ${displayText(link.to, link.toOther)}`;

const linkAria = (link: SankeyLink): string =>
  `${exactNumber(link.sessions)} sessions, ${linkTitle(link)}, ${percent(link.share)} of step ${link.step}` +
  (filterable(link) ? '. Filters the journeys table.' : '');
</script>

<div
  class="chart-wrap sankey-wrap"
  class:flat={slice.kind === 'error'}
  bind:clientWidth={width}
  bind:this={pane}
>
  {#if slice.kind === 'loading'}
    <p class="widget-note">Loading…</p>
  {:else if slice.kind === 'error'}
    <p class="widget-note">{slice.message}</p>
  {:else if cols < 2}
    <p class="widget-note">No multi-step journeys in this range.</p>
  {:else if width > 60}
    <div class="sankey-scroll">
    <svg
      width={plotWidth}
      height={HEIGHT}
      viewBox="0 0 {plotWidth} {HEIGHT}"
      role="group"
      aria-label="Journeys: sessions moving through the first {cols} steps from the entry page"
    >
      {#each layout.columns as _, c (c)}
        <text
          x={c === 0 ? colX(c) : c === cols - 1 ? colX(c) + NODE_W : colX(c) + NODE_W / 2}
          y="11"
          text-anchor={c === 0 ? 'start' : c === cols - 1 ? 'end' : 'middle'}
          class="col-title">{columnTitle(c)}</text
        >
      {/each}
      {#each layout.links as link (link.key)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex --
             docs/05 accessibility: every mark keyboard-reachable with a focus
             tooltip; named links additionally act as filter buttons -->
        <path
          d={ribbon(link)}
          class="ribbon l{link.level}"
          class:dimmed={selected !== undefined && !isSelected(link)}
          class:selected={isSelected(link)}
          class:clickable={filterable(link)}
          role={filterable(link) ? 'button' : undefined}
          tabindex="0"
          aria-label={linkAria(link)}
          onclick={filterable(link) ? () => toggle(link) : undefined}
          onkeydown={filterable(link) ? (event) => onKeydown(event, link) : undefined}
          onpointermove={(event) => showTip(link, event)}
          onpointerleave={() => (tip = undefined)}
          onfocus={() => focusTip(link)}
          onblur={() => (tip = undefined)}
        />
      {/each}
      {#each layout.columns as column, c (c)}
        {#each column as node (node.key)}
          {@const y = HEADER_H + (node.y0 + node.y1) / 2}
          {@const last = c === cols - 1}
          <rect
            class="node"
            x={colX(c)}
            y={node.y0 + HEADER_H}
            width={NODE_W}
            height={Math.max(1.5, node.y1 - node.y0)}
            rx="2"
          />
          {#if node.event}
            <rect
              class="evt"
              x={last ? colX(c) - LABEL_GAP - DOT : colX(c) + NODE_W + LABEL_GAP}
              y={y - DOT + 1.5}
              width={DOT}
              height={DOT}
              rx="2"
            />
          {/if}
          <text
            class="node-label"
            class:other={node.other}
            x={last
              ? colX(c) - LABEL_GAP - (node.event ? DOT + 4 : 0)
              : colX(c) + NODE_W + LABEL_GAP + (node.event ? DOT + 4 : 0)}
            {y}
            dy="3.5"
            text-anchor={last ? 'end' : 'start'}>{nodeText(node)}</text
          >
        {/each}
      {/each}
    </svg>
    </div>
    {#if tip !== undefined}
      <div
        class="chart-tip"
        style="left: {tip.x}px; top: {tip.y}px; transform: translate(-50%, -100%);"
      >
        <div class="tip-title">{linkTitle(tip.link)}</div>
        <div class="tip-row">
          <span class="tip-val">{exactNumber(tip.link.sessions)}</span>
          <span class="tip-name">sessions</span>
        </div>
        <div class="tip-row">
          <span class="tip-val">{percent(tip.link.share)}</span>
          <span class="tip-name">of step {tip.link.step} transitions</span>
        </div>
      </div>
    {/if}
    <!-- The chart's values without a pointer (docs/05 a11y — like the heatmap). -->
    <div class="sr-only">
      <table>
        <caption>Journey transitions</caption>
        <thead>
          <tr><th>Step</th><th>From</th><th>To</th><th>Sessions</th></tr>
        </thead>
        <tbody>
          {#each layout.links as link (link.key)}
            <tr>
              <td>{link.step}</td>
              <td>{displayText(link.from, link.fromOther)}</td>
              <td>{displayText(link.to, link.toOther)}</td>
              <td>{exactNumber(link.sessions)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .sankey-wrap {
    min-height: 320px;
  }

  /* An error is one line of copy — reserving the chart's height would leave a
   * 300px void under it. Loading keeps the reservation (no layout shift). */
  .sankey-wrap.flat {
    min-height: 0;
  }

  /* Below MIN_PLOT_W the chart scrolls in its own pane; the page never does. */
  .sankey-scroll {
    overflow-x: auto;
  }

  .col-title {
    fill: var(--muted);
    font-size: 11px;
  }

  /* Magnitude → the sequential blue ramp; identity never gets a hue. */
  .ribbon {
    opacity: 0.65;
    transition: opacity 0.1s linear;
  }

  .ribbon.l1 {
    fill: var(--hm1);
  }

  .ribbon.l2 {
    fill: var(--hm2);
  }

  .ribbon.l3 {
    fill: var(--hm3);
  }

  .ribbon.l4 {
    fill: var(--hm4);
  }

  .ribbon.dimmed {
    opacity: 0.2;
  }

  .ribbon:hover,
  .ribbon.selected {
    opacity: 1;
  }

  .ribbon.selected {
    stroke: var(--ink);
    stroke-width: 1;
  }

  .ribbon.clickable {
    cursor: pointer;
  }

  .ribbon:focus-visible {
    outline: none;
    opacity: 1;
    stroke: var(--s1);
    stroke-width: 1.5;
  }

  .node {
    fill: var(--hm5);
  }

  .node-label {
    fill: var(--ink);
    font-size: 11.5px;
    pointer-events: none;
    /* A surface-colored halo lifts labels off the ribbons they sit on. */
    stroke: var(--surface);
    stroke-width: 2.5px;
    stroke-linejoin: round;
    paint-order: stroke;
  }

  .node-label.other {
    fill: var(--muted);
  }

  .evt {
    fill: var(--s2);
  }
</style>
