import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import LineChart from './LineChart.svelte';
import type { SeriesPoint } from './series.ts';

let component: ReturnType<typeof mount> | undefined;

// happy-dom lays nothing out; give the plot the width a card would.
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  });
});
afterAll(() => {
  if (clientWidth !== undefined)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

const POINTS: SeriesPoint[] = [
  { bucket: '2026-09-27', values: { visitors: 14 } },
  { bucket: '2026-09-28', values: { visitors: 22 } },
  { bucket: '2026-10-03', values: { visitors: 3 } },
];

function render(props: { nested?: boolean; divisions?: number } = {}): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(LineChart, {
    target,
    props: { points: POINTS, metrics: ['visitors'], label: 'Visitors', height: 120, ...props },
  });
  flushSync();
  return target;
}

const ticks = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('text.tick')].map((text) => text.textContent?.trim() ?? '');

describe('LineChart', () => {
  it('labels a zero-based y-axis in whole steps', () => {
    const root = render({ divisions: 2 });
    expect(ticks(root).slice(0, 3)).toEqual(['0', '20', '40']);
  });

  it('names the bucket and its value under the pointer', () => {
    const root = render();
    const hit = root.querySelector('rect');
    hit?.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, bubbles: true }));
    flushSync();
    const tip = root.querySelector('.chart-tip')?.textContent ?? '';
    expect(tip).toContain('3');
    expect(tip).toContain('visitors');
  });

  it('is a slider with a table on its own, hidden and unfocusable nested in a control', () => {
    const own = render();
    expect(own.querySelector('[role="slider"]')).not.toBeNull();
    expect(own.querySelector('table')).not.toBeNull();
    if (component !== undefined) unmount(component);

    const nested = render({ nested: true });
    expect(nested.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(nested.querySelector('[tabindex]')).toBeNull();
    expect(nested.querySelector('table')).toBeNull();
  });
});
