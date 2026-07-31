import { describe, expect, it } from 'vitest';
import { documentHeight, READ_THRESHOLD_PCT, scrollDepthPct } from './scroll.ts';

describe('scrollDepthPct', () => {
  it('counts what the reader has seen, not where the scrollbar is', () => {
    // Viewport 1000 of a 2000-tall page, unscrolled: the top half is already read.
    expect(scrollDepthPct(0, 1_000, 2_000)).toBe(50);
    expect(scrollDepthPct(500, 1_000, 2_000)).toBe(75);
    expect(scrollDepthPct(1_000, 1_000, 2_000)).toBe(100);
  });

  // Without the viewport in the numerator this reads 0 — the page has no
  // scrollbar, so scrollY is always 0 and every short page looks unread.
  it('calls a page that fits the viewport fully read', () => {
    expect(scrollDepthPct(0, 900, 900)).toBe(100);
    expect(scrollDepthPct(0, 900, 400)).toBe(100);
  });

  it('never exceeds 100, however far the page rubber-bands', () => {
    expect(scrollDepthPct(5_000, 1_000, 2_000)).toBe(100);
    expect(scrollDepthPct(-200, 1_000, 2_000)).toBe(50);
  });

  /**
   * The lazy-loading trap: the tracker re-measures, so a page that doubled in
   * height after its images landed reports the reader further from the end than
   * the stale height would have. Reading 100 there would be the bug.
   */
  it('re-reads as a growing page pushes the end away', () => {
    expect(scrollDepthPct(1_000, 1_000, 2_000)).toBe(100);
    expect(scrollDepthPct(1_000, 1_000, 4_000)).toBe(50);
  });

  it('reads 0 rather than throwing on nonsense from a mid-layout page', () => {
    expect(scrollDepthPct(0, 1_000, 0)).toBe(0);
    expect(scrollDepthPct(0, 0, 1_000)).toBe(0);
    expect(scrollDepthPct(Number.NaN, 1_000, 2_000)).toBe(0);
    expect(scrollDepthPct(0, 1_000, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('puts the read threshold inside the range it is compared against', () => {
    expect(READ_THRESHOLD_PCT).toBeGreaterThan(0);
    expect(READ_THRESHOLD_PCT).toBeLessThanOrEqual(100);
  });
});

describe('documentHeight', () => {
  const doc = (body: Record<string, number>, root: Record<string, number>): Document =>
    ({ body, documentElement: root }) as unknown as Document;

  // Taking body alone under-reports a page whose content sits on the root
  // element — and an under-reported height reads as "finished the article".
  it('takes the tallest claim, wherever the content hangs', () => {
    expect(documentHeight(doc({ scrollHeight: 400 }, { scrollHeight: 4_000 }))).toBe(4_000);
    expect(documentHeight(doc({ scrollHeight: 4_000 }, { scrollHeight: 400 }))).toBe(4_000);
    expect(documentHeight(doc({ offsetHeight: 3_000 }, { clientHeight: 900 }))).toBe(3_000);
  });

  it('survives a document with no body yet', () => {
    expect(documentHeight({ documentElement: { scrollHeight: 100 } } as unknown as Document)).toBe(
      100,
    );
  });
});
