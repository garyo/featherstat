import type { ResultRow } from '@featherstat/shared';
import { journeyStep } from './flows.ts';
import { num } from './series.ts';

/**
 * Transitions result → sankey geometry (docs/05 R21), pure of the DOM: the
 * component measures a width and maps columns to x; everything vertical is
 * computed here in pixel units of a given plot height. Links encode magnitude,
 * never identity (chart design system): each carries a sequential wash level
 * from its share of the step, and node labels stay in ink.
 */

export interface TransitionEdge {
  /** 1-based: connects signature position `step` to `step + 1`. */
  step: number;
  from: string;
  to: string;
  sessions: number;
}

/** Transitions rows → typed edges; junk rows are dropped. */
export function transitionEdges(rows: readonly ResultRow[]): TransitionEdge[] {
  const edges: TransitionEdge[] = [];
  for (const row of rows) {
    const step = num(row.step);
    const sessions = num(row.sessions);
    if (!Number.isInteger(step) || step < 1 || sessions <= 0) continue;
    if (typeof row.from !== 'string' || typeof row.to !== 'string') continue;
    edges.push({ step, from: row.from, to: row.to, sessions });
  }
  return edges;
}

export interface SankeyNode {
  key: string;
  /** 0-based column — signature position minus one. */
  column: number;
  /** Raw step label; meaningless when `other`. */
  label: string;
  /** The per-column long-tail fold (docs/05: min-share → “Other”). */
  other: boolean;
  event: boolean;
  /** What the node's height encodes: max(sessions in, sessions out). */
  sessions: number;
  y0: number;
  y1: number;
}

export interface SankeyLink {
  key: string;
  /** 1-based step: source at column `step - 1`, target at column `step`. */
  step: number;
  from: string;
  to: string;
  fromOther: boolean;
  toOther: boolean;
  sessions: number;
  /** Share of every returned transition at this step, 0–1. */
  share: number;
  /** Sequential wash step, 1 (faint) … 4 (dominant). */
  level: 1 | 2 | 3 | 4;
  /** Top edge at the source node; the ribbon runs sy0 → sy0 + thickness. */
  sy0: number;
  /** Top edge at the target node. */
  ty0: number;
  thickness: number;
}

export interface SankeyLayout {
  /** Column index → its nodes, top to bottom. Empty when there is no data. */
  columns: SankeyNode[][];
  /** Thickest first, so thin ribbons render on top and stay hoverable. */
  links: SankeyLink[];
}

/** Nodes below this share of their column fold into “Other” (long-tail rule). */
const MIN_NODE_SHARE = 0.04;
/** Readability cap: a column names at most this many nodes before “Other”. */
const MAX_NAMED_NODES = 8;
/** Vertical space between nodes in a column. */
const NODE_GAP = 8;
/** 2px surface gaps between links stacked at a node (chart design system). */
const LINK_GAP = 2;
/** Share-of-step cut points for wash levels 2, 3 and 4. */
const WASH_CUTS = [0.06, 0.15, 0.3] as const;

/** `Entry`, `Step 2`, … — the sankey's column headers. */
export function columnTitle(column: number): string {
  return column === 0 ? 'Entry' : `Step ${column + 1}`;
}

interface Tally {
  label: string;
  in: number;
  out: number;
}

const flow = (tally: Tally): number => Math.max(tally.in, tally.out);

function tallyOf(column: Map<string, Tally>, label: string): Tally {
  let tally = column.get(label);
  if (tally === undefined) {
    tally = { label, in: 0, out: 0 };
    column.set(label, tally);
  }
  return tally;
}

/** JSON, not concatenation: labels are visitor-controlled and self-delimiting
 * JSON is the cheap way to make composed keys collision-free. */
const nodeKey = (column: number, label: string | undefined): string =>
  JSON.stringify(label === undefined ? [column] : [column, label]);

/**
 * Lay out `columns` node columns (positions 1…columns of the signature) from
 * step ≤ columns-1 edges, into a plot `height` pixels tall. Columns the data
 * never reaches are trimmed.
 */
export function buildSankey(
  edges: readonly TransitionEdge[],
  columns: number,
  height: number,
): SankeyLayout {
  const usable = edges.filter((edge) => edge.step <= columns - 1);
  if (usable.length === 0 || columns < 2) return { columns: [], links: [] };

  // Per-column session tallies, to decide the fold before links aggregate.
  const tallies: Map<string, Tally>[] = Array.from({ length: columns }, () => new Map());
  for (const edge of usable) {
    tallyOf(tallies[edge.step - 1] as Map<string, Tally>, edge.from).out += edge.sessions;
    tallyOf(tallies[edge.step] as Map<string, Tally>, edge.to).in += edge.sessions;
  }
  while (tallies.length > 0 && (tallies[tallies.length - 1] as Map<string, Tally>).size === 0) {
    tallies.pop();
  }

  const foldedLabels: Set<string>[] = tallies.map((column) => {
    const ranked = [...column.values()].sort((a, b) => flow(b) - flow(a));
    const total = ranked.reduce((sum, tally) => sum + flow(tally), 0);
    const fold = new Set<string>();
    ranked.forEach((tally, rank) => {
      // Event nodes never fold: conversions are the chart's R16/R21 story, and
      // they lose to page traffic on volume by nature. The transitions query's
      // per-step LIMIT already bounds how many can appear.
      if (journeyStep(tally.label).event) return;
      if (rank >= MAX_NAMED_NODES || flow(tally) / total < MIN_NODE_SHARE) fold.add(tally.label);
    });
    return fold;
  });
  const isFolded = (column: number, label: string): boolean =>
    foldedLabels[column]?.has(label) ?? false;

  // Links aggregate across the fold: every edge into/out of a folded label
  // lands on its column's one “Other” node.
  interface AggLink {
    key: string;
    step: number;
    from: string;
    to: string;
    fromOther: boolean;
    toOther: boolean;
    sessions: number;
  }
  const linkMap = new Map<string, AggLink>();
  const stepTotals = new Map<number, number>();
  for (const edge of usable) {
    if (edge.step > tallies.length - 1) continue;
    const fromOther = isFolded(edge.step - 1, edge.from);
    const toOther = isFolded(edge.step, edge.to);
    const key = `${nodeKey(edge.step - 1, fromOther ? undefined : edge.from)}>${nodeKey(edge.step, toOther ? undefined : edge.to)}`;
    stepTotals.set(edge.step, (stepTotals.get(edge.step) ?? 0) + edge.sessions);
    const existing = linkMap.get(key);
    if (existing !== undefined) existing.sessions += edge.sessions;
    else {
      linkMap.set(key, {
        key,
        step: edge.step,
        from: fromOther ? '' : edge.from,
        to: toOther ? '' : edge.to,
        fromOther,
        toOther,
        sessions: edge.sessions,
      });
    }
  }
  const aggregated = [...linkMap.values()];

  // Node tallies rebuilt from the folded links, so “Other” carries real totals.
  interface NodeBuild extends Tally {
    key: string;
    column: number;
    other: boolean;
    inLinks: number;
    outLinks: number;
    y0: number;
  }
  const nodeMap = new Map<string, NodeBuild>();
  const buildNode = (column: number, label: string, other: boolean): NodeBuild => {
    const key = nodeKey(column, other ? undefined : label);
    let node = nodeMap.get(key);
    if (node === undefined) {
      node = { key, column, label, other, in: 0, out: 0, inLinks: 0, outLinks: 0, y0: 0 };
      nodeMap.set(key, node);
    }
    return node;
  };
  for (const link of aggregated) {
    const source = buildNode(link.step - 1, link.from, link.fromOther);
    source.out += link.sessions;
    source.outLinks += 1;
    const target = buildNode(link.step, link.to, link.toOther);
    target.in += link.sessions;
    target.inLinks += 1;
  }

  const byColumn: NodeBuild[][] = tallies.map(() => []);
  for (const node of nodeMap.values()) byColumn[node.column]?.push(node);
  for (const column of byColumn) {
    column.sort((a, b) =>
      a.other !== b.other ? Number(a.other) - Number(b.other) : flow(b) - flow(a),
    );
  }

  // One global scale, so a link means the same sessions in every column: the
  // tightest column (weight + its fixed gap budget) sets it. The gap budget
  // over-counts slightly (max of counts vs count of the max side), which only
  // ever leaves slack — a column can never overflow `height`.
  let scale = Number.POSITIVE_INFINITY;
  for (const column of byColumn) {
    if (column.length === 0) continue;
    const weight = column.reduce((sum, node) => sum + flow(node), 0);
    const fixed =
      (column.length - 1) * NODE_GAP +
      column.reduce(
        (sum, node) => sum + Math.max(node.inLinks, node.outLinks, 1) * LINK_GAP - LINK_GAP,
        0,
      );
    scale = Math.min(scale, Math.max(0, height - fixed) / weight);
  }
  if (!Number.isFinite(scale)) scale = 0;

  const sideHeight = (sessions: number, links: number): number =>
    links === 0 ? 0 : sessions * scale + (links - 1) * LINK_GAP;

  const nodes: SankeyNode[][] = byColumn.map((column) => {
    let y = 0;
    return column.map((node) => {
      const h = Math.max(sideHeight(node.in, node.inLinks), sideHeight(node.out, node.outLinks));
      node.y0 = y;
      const laid: SankeyNode = {
        key: node.key,
        column: node.column,
        label: node.label,
        other: node.other,
        event: !node.other && journeyStep(node.label).event,
        sessions: flow(node),
        y0: y,
        y1: y + h,
      };
      y += h + NODE_GAP;
      return laid;
    });
  });

  // Pack each node's links top-down toward their far node's y — ribbons stay
  // near-parallel and crossings stay local.
  const sourceKeyOf = (link: AggLink): string =>
    nodeKey(link.step - 1, link.fromOther ? undefined : link.from);
  const targetKeyOf = (link: AggLink): string =>
    nodeKey(link.step, link.toOther ? undefined : link.to);
  const yOf = (key: string): number => nodeMap.get(key)?.y0 ?? 0;

  const sy0 = new Map<string, number>();
  const ty0 = new Map<string, number>();
  for (const node of nodeMap.values()) {
    const outs = aggregated
      .filter((link) => sourceKeyOf(link) === node.key)
      .sort((a, b) => yOf(targetKeyOf(a)) - yOf(targetKeyOf(b)) || b.sessions - a.sessions);
    let y = node.y0;
    for (const link of outs) {
      sy0.set(link.key, y);
      y += link.sessions * scale + LINK_GAP;
    }
    const ins = aggregated
      .filter((link) => targetKeyOf(link) === node.key)
      .sort((a, b) => yOf(sourceKeyOf(a)) - yOf(sourceKeyOf(b)) || b.sessions - a.sessions);
    y = node.y0;
    for (const link of ins) {
      ty0.set(link.key, y);
      y += link.sessions * scale + LINK_GAP;
    }
  }

  const links: SankeyLink[] = aggregated
    .map((link) => {
      const total = stepTotals.get(link.step) ?? link.sessions;
      const share = total === 0 ? 0 : link.sessions / total;
      return {
        key: link.key,
        step: link.step,
        from: link.from,
        to: link.to,
        fromOther: link.fromOther,
        toOther: link.toOther,
        sessions: link.sessions,
        share,
        level: (1 + WASH_CUTS.filter((cut) => share >= cut).length) as 1 | 2 | 3 | 4,
        sy0: sy0.get(link.key) ?? 0,
        ty0: ty0.get(link.key) ?? 0,
        thickness: link.sessions * scale,
      };
    })
    .sort((a, b) => b.thickness - a.thickness);

  return { columns: nodes, links };
}
