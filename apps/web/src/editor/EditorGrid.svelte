<script lang="ts">
import type { WidgetSpec } from '@featherstat/shared';
import type { GridEnv, WidgetData } from '../widgets/types.ts';
import WidgetGrid from '../widgets/WidgetGrid.svelte';
import { dropIndex, type Rect } from './drag.ts';
import { allowedWidths } from './model.ts';

/**
 * The edit-mode grid: the same `WidgetGrid` the view renders, decorated with
 * edit chrome (drag handle, width presets, settings, remove) — the rendering
 * itself is never re-implemented here (CLAUDE.md invariant 7). Drag-reorder is
 * native pointer events + CSS transforms (docs/05): rects are measured once at
 * pointerdown, the grabbed card follows via transform, the drop target only
 * changes a class — nothing reflows until the drop commits the new order.
 */
interface Props {
  grid: readonly WidgetSpec[];
  dataFor: (spec: WidgetSpec) => WidgetData;
  /** Passed through untouched: the preview renders in the view's own
   * environment, which is what makes it a preview and not an approximation. */
  env: GridEnv;
  onreorder: (from: number, to: number) => void;
  onresize: (id: string, w: number) => void;
  onremove: (id: string) => void;
  onsettings: (id: string) => void;
  onquery: (id: string) => void;
}

let { grid, dataFor, env, onreorder, onresize, onremove, onsettings, onquery }: Props = $props();

let gridEl = $state<HTMLElement | undefined>(undefined);
let dragFrom = $state(-1);
let dragTo = $state(-1);
let dragTransform = $state('');
let rects: Rect[] = [];
let origin = { x: 0, y: 0 };

function startDrag(event: PointerEvent, index: number): void {
  if (event.button !== 0 || gridEl === undefined) return;
  rects = [...gridEl.querySelectorAll<HTMLElement>('.ew')].map((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  dragFrom = index;
  dragTo = index;
  origin = { x: event.clientX, y: event.clientY };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveDrag(event: PointerEvent): void {
  if (dragFrom < 0) return;
  dragTransform = `translate(${event.clientX - origin.x}px, ${event.clientY - origin.y}px)`;
  dragTo = dropIndex(rects, event.clientX, event.clientY, dragFrom);
}

function endDrag(): void {
  if (dragFrom < 0) return;
  const from = dragFrom;
  const to = dragTo;
  dragFrom = -1;
  dragTo = -1;
  dragTransform = '';
  if (from !== to) onreorder(from, to);
}
</script>

<WidgetGrid {grid} {dataFor} {env} bind:element={gridEl}>
  {#snippet card({ spec, index, frame, widget })}
    {@const widths = allowedWidths(spec.viz)}
    <div
      class="ew {frame}"
      class:dragging={dragFrom === index}
      class:drop-target={dragFrom >= 0 && dragFrom !== index && dragTo === index}
      style:transform={dragFrom === index ? dragTransform : undefined}
    >
      <div class="echrome">
        <button
          class="tool drag"
          type="button"
          title="Drag to reorder"
          aria-label="Reorder {spec.title ?? spec.viz}"
          onpointerdown={(event) => startDrag(event, index)}
          onpointermove={moveDrag}
          onpointerup={endDrag}
          onpointercancel={endDrag}>⠿</button
        >
        <span class="etitle">{spec.title ?? spec.viz}</span>
        {#if widths.length > 1}
          <span class="widths" role="group" aria-label="Width in grid columns">
            {#each widths as w (w)}
              <button
                class="tool"
                type="button"
                aria-pressed={spec.w === w}
                onclick={() => onresize(spec.id, w)}>{w}</button
              >
            {/each}
          </span>
        {/if}
        <button class="tool" type="button" title="Show query" onclick={() => onquery(spec.id)}
          >&lbrace;&rbrace;</button
        >
        <button class="tool" type="button" title="Widget settings" onclick={() => onsettings(spec.id)}
          >Edit</button
        >
        <button class="tool danger" type="button" title="Remove widget" onclick={() => onremove(spec.id)}
          >✕</button
        >
      </div>
      {@render widget()}
    </div>
  {/snippet}
</WidgetGrid>

<style>
  .ew {
    position: relative;
  }

  .ew.dragging {
    z-index: 10;
    opacity: 0.85;
    cursor: grabbing;
  }

  .ew.drop-target {
    outline: 2px dashed var(--s1);
    outline-offset: 2px;
  }

  .echrome {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    padding: 4px 6px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--s1) 4%, transparent);
  }

  .etitle {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
  }

  .widths {
    display: flex;
    gap: 2px;
  }

  .tool {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink-2);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
  }

  .tool:hover {
    color: var(--ink);
  }

  .tool:focus-visible {
    outline: 2px solid var(--s1);
    outline-offset: 1px;
  }

  .tool[aria-pressed='true'] {
    border-color: var(--s1);
    color: var(--ink);
  }

  .tool.danger:hover {
    color: var(--bad);
    border-color: var(--bad);
  }

  .drag {
    cursor: grab;
    touch-action: none;
  }
</style>
