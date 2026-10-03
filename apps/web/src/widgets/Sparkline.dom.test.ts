import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Sparkline from './Sparkline.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component !== undefined) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

function ys(data: readonly (number | undefined)[]): number[] {
  component = mount(Sparkline, { target: document.body, props: { data, width: 100, height: 40 } });
  flushSync();
  const points = document.querySelector('polyline')?.getAttribute('points') ?? '';
  return points.split(' ').map((point) => Number(point.split(',')[1]));
}

/** `height - PAD`: where zero sits. */
const FLOOR = 37;

describe('Sparkline', () => {
  it('anchors the axis at zero, so the smallest value is not drawn as nothing', () => {
    const [, top, low] = ys([10, 12, 4]);
    expect(top).toBe(3);
    expect(low).toBeCloseTo(FLOOR - (4 / 12) * 34, 1);
  });

  it('draws a zero on the floor', () => {
    expect(ys([5, 0, 5])[1]).toBe(FLOOR);
  });

  it('draws an all-zero series flat on the floor', () => {
    expect(ys([0, 0, 0])).toEqual([FLOOR, FLOOR, FLOOR]);
  });
});
