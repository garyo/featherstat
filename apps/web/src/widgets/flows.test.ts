import { describe, expect, it } from 'vitest';
import { flowRows, flowsThroughEdge, foldMiddle, journeyStep, percent } from './flows.ts';

describe('journeyStep', () => {
  it('splits the server label convention into page and event steps', () => {
    expect(journeyStep('/pricing')).toEqual({ text: '/pricing', event: false });
    expect(journeyStep('event: signup · account-created')).toEqual({
      text: 'signup · account-created',
      event: true,
    });
  });

  it('names the empty label a title-only pageview produces', () => {
    expect(journeyStep('')).toEqual({ text: '(untitled)', event: false });
  });
});

describe('flowRows', () => {
  it('parses, sorts by sessions and scales wash bars to the top row', () => {
    const rows = flowRows([
      { steps: ['/', '/docs'], sessions: 20, avg_engaged_ms: 30_000, exit_rate: 0.5 },
      { steps: ['/'], sessions: 80, avg_engaged_ms: 12_000, exit_rate: 1 },
    ]);
    expect(rows.map((row) => row.sessions)).toEqual([80, 20]);
    expect(rows[0]?.pct).toBe(100);
    expect(rows[1]?.pct).toBe(25);
    expect(rows[1]?.avgMs).toBe(30_000);
    expect(rows[1]?.exitRate).toBe(0.5);
  });

  it('drops rows without a signature or sessions and clamps exit rates', () => {
    const rows = flowRows([
      { steps: [], sessions: 5, avg_engaged_ms: 0, exit_rate: 0 },
      { steps: 'not-an-array', sessions: 5, avg_engaged_ms: 0, exit_rate: 0 },
      { steps: ['/'], sessions: 0, avg_engaged_ms: 0, exit_rate: 0 },
      { steps: ['/'], sessions: 3, avg_engaged_ms: null, exit_rate: 1.4 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.avgMs).toBe(0);
    expect(rows[0]?.exitRate).toBe(1);
  });
});

describe('flowsThroughEdge', () => {
  const rows = flowRows([
    { steps: ['/', '/docs', '/pricing'], sessions: 10, avg_engaged_ms: 0, exit_rate: 0 },
    { steps: ['/', '/pricing'], sessions: 9, avg_engaged_ms: 0, exit_rate: 0 },
    { steps: ['/docs', '/', '/docs'], sessions: 8, avg_engaged_ms: 0, exit_rate: 0 },
  ]);

  it('matches positionally — the sankey is entry-anchored', () => {
    const step1 = flowsThroughEdge(rows, { step: 1, from: '/', to: '/docs' });
    expect(step1.map((row) => row.steps)).toEqual([['/', '/docs', '/pricing']]);
    // '/' → '/docs' also occurs at step 2 of the third row, but not at step 1.
    const step2 = flowsThroughEdge(rows, { step: 2, from: '/', to: '/docs' });
    expect(step2.map((row) => row.steps)).toEqual([['/docs', '/', '/docs']]);
  });

  it('returns nothing for an edge no signature contains', () => {
    expect(flowsThroughEdge(rows, { step: 1, from: '/pricing', to: '/' })).toEqual([]);
  });
});

describe('foldMiddle', () => {
  it('leaves short signatures whole', () => {
    expect(foldMiddle(['/', '/a', '/b'])).toEqual({ head: ['/', '/a', '/b'], folded: 0, tail: [] });
  });

  it('folds the middle first, keeping the entry run and the exit', () => {
    const steps = ['/one', '/two', '/three', '/four', '/five'];
    const folded = foldMiddle(steps, 24);
    expect(folded.head).toEqual(['/one', '/two']);
    expect(folded.tail).toEqual(['/five']);
    expect(folded.folded).toBe(2);
  });

  it('always folds at least one step once over budget', () => {
    const folded = foldMiddle(['/aaaa', '/bbbb', '/cccc', '/dddd'], 10);
    expect(folded.folded).toBeGreaterThanOrEqual(1);
    expect(folded.head.length + folded.folded + folded.tail.length).toBe(4);
  });

  it('never folds below two leading steps', () => {
    const folded = foldMiddle(['/very-long-first', '/very-long-second', '/x', '/y', '/z'], 5);
    expect(folded.head).toHaveLength(2);
    expect(folded.tail).toEqual(['/z']);
  });
});

describe('percent', () => {
  it('rounds to whole percentages', () => {
    expect(percent(0.625)).toBe('63%');
    expect(percent(0)).toBe('0%');
    expect(percent(1)).toBe('100%');
  });
});
