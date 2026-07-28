import { describe, expect, it } from 'vitest';
import { dropIndex, type Rect } from './drag.ts';

/** A 2×2 grid of 100×100 cards with a 10px gutter. */
const rects: Rect[] = [
  { left: 0, top: 0, width: 100, height: 100 },
  { left: 110, top: 0, width: 100, height: 100 },
  { left: 0, top: 110, width: 100, height: 100 },
  { left: 110, top: 110, width: 100, height: 100 },
];

describe('dropIndex', () => {
  it('answers the card under the pointer', () => {
    expect(dropIndex(rects, 50, 50, 3)).toBe(0);
    expect(dropIndex(rects, 150, 150, 0)).toBe(3);
    expect(dropIndex(rects, 0, 0, 3)).toBe(0); // edges are inside
  });

  it('answers the nearest card from a gutter or outside the grid', () => {
    expect(dropIndex(rects, 105, 30, 3)).toBeLessThanOrEqual(1); // mid-gutter: one of the top pair
    expect(dropIndex(rects, 300, 160, 0)).toBe(3); // right of the grid, bottom row
    expect(dropIndex(rects, -40, -40, 3)).toBe(0); // above/left of everything
  });

  it('falls back when there is nothing to hit', () => {
    expect(dropIndex([], 10, 10, 2)).toBe(2);
  });
});
