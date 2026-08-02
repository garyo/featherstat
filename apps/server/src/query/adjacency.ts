import type { AdjacencyQuery, FilterNode, SiteWindow } from '@featherstat/shared';
import type { CompileError } from './compiler.ts';
import { populationWhere } from './population.ts';
import { STEP_LABEL } from './sequences.ts';
import { sessionScope } from './session-scope.ts';

/**
 * AdjacencyQuery → parameterized SQL (docs/03 § Journeys, docs/04 § 3): what
 * came just before — or just after — one page, anywhere in each session in
 * scope, over the same session-scoped envelope as the sequence kinds.
 *
 * Steps are the sequence kinds' steps exactly: the `actions` population labeled
 * by `STEP_LABEL`, with consecutive identical labels collapsed into one step.
 * The collapse here is the boundary test itself — a row whose neighbor wears
 * the SAME label sits inside a run, and `adj IS NOT label` drops it, so a
 * reload or an outlink taken from the page it labels is never an adjacency.
 *
 * A session that STARTS at the page has no predecessor: its neighbor is NULL,
 * which the same boundary test admits, and it reads as `(entry)`. Symmetrically
 * a session that ENDS there reads as `(exit)` under direction 'out'. Rows count
 * DISTINCT sessions containing the adjacency, so a visitor bouncing A→X→A→X
 * is one session on the `A` row, not two.
 */

export interface CompiledAdjacency {
  kind: 'adjacency';
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
}

export function compileAdjacencyQuery(
  query: AdjacencyQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledAdjacency | CompileError {
  const scope = sessionScope('adjacency queries', filters, windows);
  if ('error' in scope) return scope;

  // 'in' looks at each row's predecessor, 'out' at its successor; the window
  // function and the pseudo-row label are the whole difference.
  const [neighbor, boundary] =
    query.direction === 'in' ? (['LAG', '(entry)'] as const) : (['LEAD', '(exit)'] as const);
  const params = [...scope.params, query.path, query.limit];
  const sql = [
    `${scope.sql},`,
    'walked AS (',
    `  SELECT sid, label, ${neighbor}(label) OVER (PARTITION BY sid ORDER BY seq) AS adj`,
    '  FROM (',
    `    SELECT e.session_id AS sid, e.seq AS seq, ${STEP_LABEL} AS label`,
    '    FROM events e JOIN scoped ON e.session_id = scoped.sid',
    `    WHERE ${populationWhere('actions', 'e')}`,
    '  )',
    ')',
    // The boundary label is a fixed sentinel, never a page: pages label as
    // their path, which always starts with '/' or reads 'event: …' or ''.
    `SELECT CASE WHEN adj IS NULL THEN '${boundary}' ELSE adj END AS label,`,
    '  COUNT(DISTINCT sid) AS sessions',
    'FROM walked',
    'WHERE label = ? AND adj IS NOT label',
    'GROUP BY 1',
    'ORDER BY sessions DESC, label',
    'LIMIT ?',
  ].join('\n');
  return { kind: 'adjacency', sql, params };
}
