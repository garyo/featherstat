import type { ResultRow } from '@featherstat/shared';
import { num } from './series.ts';

/**
 * Pure shaping for the journeys view (docs/05 R21): the top-journeys table's
 * rows plus the step-label vocabulary it shares with the sankey. The server
 * labels a step with the page path for pageviews/outlinks/downloads and
 * `event: <category> · <action>` for events (server query/sequences.ts) —
 * the one convention both widgets decode.
 */

const EVENT_PREFIX = 'event: ';

export interface JourneyStep {
  /** Display text: the path, or the event's `category · action`. */
  text: string;
  /** Event steps wear the small orange dot (mockup journeys card). */
  event: boolean;
}

/** A title-only pageview stores no URL and arrives as '' — never a blank cell. */
const UNTITLED = '(untitled)';

export function journeyStep(label: string): JourneyStep {
  if (label.startsWith(EVENT_PREFIX)) {
    return { text: label.slice(EVENT_PREFIX.length), event: true };
  }
  return { text: label === '' ? UNTITLED : label, event: false };
}

export interface FlowRow {
  /** The session signature, entry first — raw labels (see `journeyStep`). */
  steps: string[];
  sessions: number;
  avgMs: number;
  /** 0–1: sessions that went no further than this signature. */
  exitRate: number;
  /** Share of the largest row, 0–100 — the sessions cell's wash bar width. */
  pct: number;
}

/** Flows result rows → display rows, sorted by sessions; junk rows are dropped. */
export function flowRows(rows: readonly ResultRow[]): FlowRow[] {
  const parsed: FlowRow[] = [];
  for (const row of rows) {
    const steps = row.steps;
    if (!Array.isArray(steps) || steps.length === 0) continue;
    const sessions = num(row.sessions);
    if (sessions <= 0) continue;
    parsed.push({
      steps: steps.map(String),
      sessions,
      avgMs: num(row.avg_engaged_ms),
      exitRate: Math.min(1, Math.max(0, num(row.exit_rate))),
      pct: 0,
    });
  }
  parsed.sort((a, b) => b.sessions - a.sessions);
  const max = parsed[0]?.sessions ?? 1;
  for (const row of parsed) row.pct = (row.sessions / max) * 100;
  return parsed;
}

/**
 * One sankey link, named the way the table filters: `from` sits at 1-based
 * position `step` of a signature and `to` at `step + 1`.
 */
export interface EdgeRef {
  step: number;
  from: string;
  to: string;
  /** The link's total sessions — the table says how much of it its top rows cover. */
  sessions?: number;
}

/**
 * The table rows behind a clicked sankey link — client-side over the already
 * loaded flows result: the view's single batch fetched both widgets, so a
 * selection never re-queries. The match is positional, not anywhere-in-journey:
 * the sankey is entry-anchored, so its step-k edge means signature positions
 * k and k+1.
 */
export function flowsThroughEdge(rows: readonly FlowRow[], edge: EdgeRef): FlowRow[] {
  return rows.filter(
    (row) => row.steps[edge.step - 1] === edge.from && row.steps[edge.step] === edge.to,
  );
}

export interface FoldedSteps {
  head: string[];
  /** Steps hidden behind the middle ellipsis; 0 when nothing folded. */
  folded: number;
  /** The exit step, kept visible whenever the middle folds. */
  tail: string[];
}

/** What `parts` cost joined with ' → ' — the fold budget's unit. */
function joinedWidth(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + part.length, 0) + (parts.length - 1) * 3;
}

/**
 * Long signatures fold in the middle (mockup: →-joined, ellipsized middle):
 * a journey's identity lives at its entry and its exit, so the middle gives
 * way first. CSS end-ellipsis stays the backstop for single huge labels.
 */
export function foldMiddle(steps: readonly string[], maxChars = 72): FoldedSteps {
  if (steps.length <= 3 || joinedWidth(steps) <= maxChars) {
    return { head: [...steps], folded: 0, tail: [] };
  }
  const tail = steps.slice(-1);
  let keep = steps.length - 2;
  while (keep > 2 && joinedWidth([...steps.slice(0, keep), '…', ...tail]) > maxChars) keep -= 1;
  return { head: steps.slice(0, keep), folded: steps.length - 1 - keep, tail };
}

/** `0.62` → `62%` — exit rates and step shares. */
export function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
