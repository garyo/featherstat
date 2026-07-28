import type { ResultRow } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import {
  buildSankey,
  columnTitle,
  type SankeyLayout,
  type SankeyLink,
  type SankeyNode,
  transitionEdges,
} from './sankey.ts';

const edge = (step: number, from: string, to: string, sessions: number): ResultRow => ({
  step,
  from,
  to,
  sessions,
});

const HEIGHT = 300;

function nodeOf(layout: SankeyLayout, column: number, label: string): SankeyNode {
  const node = layout.columns[column]?.find((n) => !n.other && n.label === label);
  if (node === undefined) throw new Error(`no node '${label}' in column ${column}`);
  return node;
}

function otherOf(layout: SankeyLayout, column: number): SankeyNode | undefined {
  return layout.columns[column]?.find((n) => n.other);
}

function linkOf(layout: SankeyLayout, step: number, from: string, to: string): SankeyLink {
  const link = layout.links.find((l) => l.step === step && l.from === from && l.to === to);
  if (link === undefined) throw new Error(`no link ${from} → ${to} at step ${step}`);
  return link;
}

describe('transitionEdges', () => {
  it('parses rows and drops junk', () => {
    const edges = transitionEdges([
      edge(1, '/', '/docs', 40),
      { step: 'x', from: '/', to: '/a', sessions: 5 },
      { step: 1, from: null, to: '/a', sessions: 5 },
      { step: 0, from: '/', to: '/a', sessions: 5 },
      { step: 2, from: '/', to: '/a', sessions: 0 },
    ]);
    expect(edges).toEqual([{ step: 1, from: '/', to: '/docs', sessions: 40 }]);
  });
});

describe('buildSankey', () => {
  it('returns an empty layout without data', () => {
    expect(buildSankey([], 4, HEIGHT)).toEqual({ columns: [], links: [] });
  });

  it('places nodes by signature position and orders columns by flow', () => {
    const layout = buildSankey(
      transitionEdges([
        edge(1, '/', '/docs', 60),
        edge(1, '/', '/pricing', 30),
        edge(2, '/docs', '/api', 20),
      ]),
      3,
      HEIGHT,
    );
    expect(layout.columns).toHaveLength(3);
    expect(layout.columns[0]?.map((n) => n.label)).toEqual(['/']);
    expect(layout.columns[1]?.map((n) => n.label)).toEqual(['/docs', '/pricing']);
    expect(layout.columns[2]?.map((n) => n.label)).toEqual(['/api']);
    // Bigger flow sits higher; nodes never overlap.
    const docs = nodeOf(layout, 1, '/docs');
    const pricing = nodeOf(layout, 1, '/pricing');
    expect(docs.y0).toBeLessThan(pricing.y0);
    expect(pricing.y0).toBeGreaterThanOrEqual(docs.y1);
  });

  it('scales links to sessions and fits every column inside the height', () => {
    const layout = buildSankey(
      transitionEdges([
        edge(1, '/', '/docs', 60),
        edge(1, '/', '/pricing', 30),
        edge(2, '/docs', '/api', 20),
      ]),
      3,
      HEIGHT,
    );
    const big = linkOf(layout, 1, '/', '/docs');
    const small = linkOf(layout, 1, '/', '/pricing');
    expect(big.thickness / small.thickness).toBeCloseTo(2, 5);
    for (const column of layout.columns) {
      for (const node of column) {
        expect(node.y1).toBeLessThanOrEqual(HEIGHT + 1e-6);
        expect(node.y1).toBeGreaterThanOrEqual(node.y0);
      }
    }
    // The entry column carries the full 90 sessions and sets the global scale.
    const entry = nodeOf(layout, 0, '/');
    expect(entry.sessions).toBe(90);
    expect(entry.y1 - entry.y0).toBeCloseTo(big.thickness + 2 + small.thickness, 5);
  });

  it('keeps a 2px surface gap between links stacked at a node', () => {
    const layout = buildSankey(
      transitionEdges([edge(1, '/', '/docs', 60), edge(1, '/', '/pricing', 30)]),
      2,
      HEIGHT,
    );
    const [first, second] = [...layout.links].sort((a, b) => a.sy0 - b.sy0);
    expect(first).toBeDefined();
    expect(second?.sy0).toBeCloseTo((first?.sy0 ?? 0) + (first?.thickness ?? 0) + 2, 5);
  });

  it('computes share of step and maps it to sequential wash levels', () => {
    const layout = buildSankey(
      transitionEdges([
        edge(1, '/', '/a', 66),
        edge(1, '/', '/b', 20),
        edge(1, '/', '/c', 9),
        edge(1, '/', '/d', 5),
      ]),
      2,
      HEIGHT,
    );
    expect(linkOf(layout, 1, '/', '/a').share).toBeCloseTo(0.66, 5);
    expect(linkOf(layout, 1, '/', '/a').level).toBe(4);
    expect(linkOf(layout, 1, '/', '/b').level).toBe(3);
    expect(linkOf(layout, 1, '/', '/c').level).toBe(2);
    expect(linkOf(layout, 1, '/', '/d').level).toBe(1);
  });

  it('folds the sub-share tail into one Other node per column, links aggregated', () => {
    const layout = buildSankey(
      transitionEdges([
        edge(1, '/', '/big', 97),
        edge(1, '/', '/tiny-a', 2),
        edge(1, '/', '/tiny-b', 1),
      ]),
      2,
      HEIGHT,
    );
    const other = otherOf(layout, 1);
    expect(other).toBeDefined();
    expect(other?.sessions).toBe(3);
    // Other sits last even though ordering is otherwise by flow.
    expect(layout.columns[1]?.at(-1)?.other).toBe(true);
    const folded = layout.links.filter((l) => l.toOther);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.sessions).toBe(3);
    // The named side keeps its label; a fully-named edge is filterable.
    expect(folded[0]?.from).toBe('/');
    expect(linkOf(layout, 1, '/', '/big').toOther).toBe(false);
  });

  it('never folds event nodes, however small their share (R16: conversions are the story)', () => {
    const layout = buildSankey(
      transitionEdges([
        edge(1, '/', '/big', 97),
        edge(1, '/', 'event: signup · created', 1),
        edge(1, '/', '/tiny', 2),
      ]),
      2,
      HEIGHT,
    );
    // The page below the share floor folds; the equally small event stays named.
    expect(otherOf(layout, 1)?.sessions).toBe(2);
    expect(nodeOf(layout, 1, 'event: signup · created').event).toBe(true);
    expect(linkOf(layout, 1, '/', 'event: signup · created').toOther).toBe(false);
  });

  it('marks event nodes for the orange-dot convention', () => {
    const layout = buildSankey(
      transitionEdges([edge(1, '/', 'event: signup · created', 50)]),
      2,
      HEIGHT,
    );
    expect(nodeOf(layout, 1, 'event: signup · created').event).toBe(true);
    expect(nodeOf(layout, 0, '/').event).toBe(false);
  });

  it('ignores edges past the requested depth and trims unreached columns', () => {
    const layout = buildSankey(
      transitionEdges([edge(1, '/', '/a', 50), edge(3, '/x', '/y', 40)]),
      3,
      HEIGHT,
    );
    expect(layout.columns).toHaveLength(2);
    expect(layout.links).toHaveLength(1);
  });

  it('renders links thickest-first so thin ribbons stay hoverable', () => {
    const layout = buildSankey(
      transitionEdges([edge(1, '/', '/a', 10), edge(1, '/', '/b', 90)]),
      2,
      HEIGHT,
    );
    expect(layout.links.map((l) => l.to)).toEqual(['/b', '/a']);
  });
});

describe('columnTitle', () => {
  it('names the entry column and numbers the rest by signature position', () => {
    expect(columnTitle(0)).toBe('Entry');
    expect(columnTitle(1)).toBe('Step 2');
    expect(columnTitle(4)).toBe('Step 5');
  });
});
