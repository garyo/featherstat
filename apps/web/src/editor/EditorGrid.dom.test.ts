import type { WidgetSpec } from '@featherstat/shared';
import { flushSync, mount, tick, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { afterEach, describe, expect, it } from 'vitest';
import type { GridEnv } from '../widgets/types.ts';
import EditorGrid from './EditorGrid.svelte';
import { reorder } from './model.ts';

/** Reordering is not a pointer-only affordance (docs/05 § Accessibility). */

const ENV: GridEnv = {
  rangeLabel: 'last 30 days',
  scope: 1,
  now: Date.UTC(2026, 6, 30),
  realtime: null,
  sites: null,
  onopenrealtime: null,
  onselectsite: null,
  onfilter: null,
  ondrill: null,
  onpivot: null,
  windows: null,
  annotations: null,
};

const card = (id: string): WidgetSpec => ({
  id,
  viz: 'bar-list',
  w: 6,
  h: 2,
  title: id,
  query: { id, metrics: ['pageviews'], dim: 'path', limit: 8 },
  options: {},
});

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
});

/** Mounts the grid with a layout its own reorders write back, as the editor does. */
function render(): { root: HTMLElement; order: () => string[] } {
  const layout = new SvelteMap([['grid', ['Pages', 'Referrers', 'Countries'].map(card)]]);
  const grid = (): WidgetSpec[] => layout.get('grid') ?? [];
  const root = document.createElement('div');
  document.body.append(root);
  mounted.push(
    mount(EditorGrid, {
      target: root,
      props: {
        get grid() {
          return grid();
        },
        dataFor: () => ({ phase: 'loading', results: {} }),
        env: ENV,
        onreorder: (from: number, to: number) => layout.set('grid', reorder(grid(), from, to)),
        onresize: () => undefined,
        onremove: () => undefined,
        onsettings: () => undefined,
        onquery: () => undefined,
      },
    }),
  );
  flushSync();
  return { root, order: () => grid().map((spec) => spec.id) };
}

const handles = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('button.drag'),
];

async function press(target: HTMLElement, key: string): Promise<void> {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flushSync();
  await tick();
}

describe('moving a widget from the keyboard', () => {
  it('moves the card with the arrow keys, says where it landed, and keeps focus on it', async () => {
    const { root, order } = render();
    const first = handles(root)[0] as HTMLButtonElement;
    first.focus();

    await press(first, 'ArrowRight');
    expect(order()).toEqual(['Referrers', 'Pages', 'Countries']);
    expect(root.querySelector('[aria-live]')?.textContent).toBe('Pages moved to position 2 of 3');
    expect(document.activeElement).toBe(handles(root)[1]);

    await press(handles(root)[1] as HTMLButtonElement, 'End');
    expect(order()).toEqual(['Referrers', 'Countries', 'Pages']);
    expect(root.querySelector('[aria-live]')?.textContent).toBe('Pages moved to position 3 of 3');
  });

  it('claims no key it does not act on', async () => {
    const { root, order } = render();
    const first = handles(root)[0] as HTMLButtonElement;
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    first.dispatchEvent(tab);
    await press(first, 'ArrowLeft');
    expect(tab.defaultPrevented).toBe(false);
    expect(order()).toEqual(['Pages', 'Referrers', 'Countries']);
  });
});
