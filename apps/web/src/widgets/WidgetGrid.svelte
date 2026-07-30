<script lang="ts">
import type { WidgetSpec } from '@featherstat/shared';
import type { Snippet } from 'svelte';
import { CAPABILITY_NOTE, missingCapability } from './env.ts';
import { REGISTRY, spanClass } from './registry.ts';
import type { GridEnv, WidgetData } from './types.ts';

/**
 * The one place a widget spec becomes a rendered component (CLAUDE.md
 * invariant 7 — one rendering per thing rendered): the layout loop, the
 * registry lookup, the card's frame in the 12-column grammar, the placeholder
 * for a viz nothing implements yet or nothing here can feed, and the
 * environment every widget renders from. A new widget capability is one field
 * on `WidgetEnv` and both paths gain it — the view path and the editor's
 * preview forked once, and each capability added after that had to be added
 * twice (and twice wasn't).
 *
 * Callers decorate instead of copying: the grid frames nothing itself, it hands
 * each card back as a `widget` snippet and the caller wraps it — the view with
 * its hover "show query" button, the editor with its drag handle, width presets
 * and remove tools.
 */
interface Card {
  spec: WidgetSpec;
  /** Position in the layout — the editor's drag geometry counts in indices. */
  index: number;
  /** Frame classes for the card element: `wide`, or `card` plus its span. */
  frame: string;
  /** The rendered widget; the decorator places it inside its frame. */
  widget: Snippet;
}

interface Props {
  grid: readonly WidgetSpec[];
  /** One widget's share of the view's single batch (invariant 1: views batch). */
  dataFor: (spec: WidgetSpec) => WidgetData;
  /** The card frame, per widget — this is the decoration seam. */
  card: Snippet<[Card]>;
  /** Everything the widgets render from besides their spec. */
  env: GridEnv;
  refetching?: boolean;
  /** The grid element, for a decorator that measures its cards (drag-reorder). */
  element?: HTMLElement | undefined;
}

let { grid, dataFor, card, env, refetching = false, element = $bindable() }: Props = $props();
</script>

<div class="grid" class:refetching bind:this={element}>
  {#each grid as spec, index (spec.id)}
    {@const entry = REGISTRY[spec.viz]}
    {@const frame = entry?.frame === 'wide' ? 'wide' : `card ${spanClass(spec.w)}`}
    {#snippet widget()}
      <!-- A grid never composes a heading or shares a highlight: those belong to
           a page that arranges widgets by hand (the Realtime view). -->
      {@const widgetEnv = { ...env, data: dataFor(spec), headless: false, highlight: null }}
      {@const missing = missingCapability(spec.viz, widgetEnv)}
      {#if entry === undefined}
        <h2>{spec.title ?? spec.viz}</h2>
        <p class="widget-note">The “{spec.viz}” widget isn’t available yet.</p>
      {:else if missing !== undefined}
        <h2>{spec.title ?? spec.viz}</h2>
        <p class="widget-note">{CAPABILITY_NOTE[missing]}</p>
      {:else}
        {@const Widget = entry.component}
        <Widget {spec} env={widgetEnv} />
      {/if}
    {/snippet}
    {@render card({ spec, index, frame, widget })}
  {/each}
</div>

<style>
  /* The refetch hold (docs/05): previous render stays, dimmed — never a skeleton. */
  .grid {
    transition: opacity 0.15s linear;
  }

  .grid.refetching {
    opacity: 0.6;
  }
</style>
