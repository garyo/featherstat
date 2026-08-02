import type { FilterNode, SequenceQuery, SiteWindow } from '@featherstat/shared';
import type { CompileError } from './compiler.ts';
import { populationWhere } from './population.ts';
import { sessionScope } from './session-scope.ts';

/**
 * SequenceQuery → parameterized SQL (docs/03 § Journeys, docs/04 § 3). Sequence
 * queries run over the session-scoped envelope (session-scope.ts), and every
 * non-ping event of a picked session participates.
 *
 * A step's label is the page path for pageviews/outlinks/downloads and
 * `event: <category> · <action>` for events. Pings are session upkeep, not
 * steps: `seq` orders a session's rows, and ROW_NUMBER over the non-ping rows
 * renumbers around the pings sitting between them.
 *
 * Consecutive identical labels collapse into one step. A journey diagram is
 * about movement BETWEEN pages, so `/ → / → /` is one visit to `/`, whether the
 * repeat came from a reload, an outlink taken from the page it labels, or an SPA
 * router announcing one navigation twice (docs/03 § Journeys, docs/06).
 */

export interface CompiledSequence {
  kind: SequenceQuery['kind'];
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
}

/** NULL never labels a step: a title-only pageview (no URL) reads as ''.
 * Shared with the adjacency kind (adjacency.ts) — one spelling of what a step is. */
export const STEP_LABEL = `COALESCE(CASE WHEN e.type = 'event'
        THEN 'event: ' || e.event_category || ' · ' || e.event_action
        ELSE e.path END, '')`;

export function compileSequenceQuery(
  query: SequenceQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledSequence | CompileError {
  const scope = sessionScope(
    'sequence queries',
    filters,
    windows,
    query.kind === 'flows' ? ['s.engaged_ms AS engaged_ms'] : [],
  );
  if ('error' in scope) return scope;

  const { params } = scope;
  const walked = [
    'walked AS (',
    // Consecutive identical labels are one step, so what both kinds want is the
    // RUNS. `next` names what follows each row, which makes the last row of a
    // run the one whose successor differs — and the collapse is then a WHERE
    // clause, which SQL runs ahead of windowing. Nothing below pays an extra
    // ordered pass for it.
    '  SELECT sid, seq, label, LEAD(label) OVER (PARTITION BY sid ORDER BY seq) AS next',
    '  FROM (',
    `    SELECT e.session_id AS sid, e.seq AS seq, ${STEP_LABEL} AS label`,
    '    FROM events e JOIN scoped ON e.session_id = scoped.sid',
    // A journey is what the visitor DID: the `actions` population, so a
    // heartbeat never becomes a step.
    `    WHERE ${populationWhere('actions', 'e')}`,
    '  )',
    ')',
  ].join('\n');

  if (query.kind === 'transitions') {
    // One edge per session per step; `limit` keeps the top edges of every step,
    // so a deep layer is never starved by a busy entry layer.
    params.push(query.steps, query.limit);
    const sql = [
      `${scope.sql},`,
      `${walked},`,
      // A move is a run ending against a DIFFERENT label, so a repeated page is
      // never an edge to itself and never spends a step (docs/03 § Journeys).
      'moves AS (',
      '  SELECT ROW_NUMBER() OVER (PARTITION BY sid ORDER BY seq) AS step, label, next',
      '  FROM walked WHERE next IS NOT NULL AND next IS NOT label',
      '),',
      'edges AS (',
      '  SELECT step, label AS "from", next AS "to", COUNT(*) AS sessions',
      '  FROM moves WHERE step <= ?',
      '  GROUP BY 1, 2, 3',
      ')',
      'SELECT step, "from", "to", sessions FROM (',
      '  SELECT edges.*, ROW_NUMBER() OVER (',
      '    PARTITION BY step ORDER BY sessions DESC, "from", "to") AS pick',
      '  FROM edges',
      ') WHERE pick <= ?',
      'ORDER BY step, sessions DESC, "from", "to"',
    ].join('\n');
    return { kind: query.kind, sql, params };
  }

  params.push(query.steps, query.steps, query.steps, query.limit);
  const sql = [
    `${scope.sql},`,
    `${walked},`,
    // One entry per run, and their count. A session's last row ends a run too:
    // `next` is NULL there, which differs from every label.
    'runs AS (',
    '  SELECT sid,',
    '    json_group_array(label ORDER BY seq) FILTER (WHERE label IS NOT next) AS walk,',
    '    COUNT(*) FILTER (WHERE label IS NOT next) AS total',
    '  FROM walked GROUP BY sid',
    '),',
    'signatures AS (',
    '  SELECT sid, total,',
    // Most journeys are shorter than the depth asked for, and theirs already IS
    // the signature; only the longer ones pay to be cut down to it.
    '    CASE WHEN total <= ? THEN walk ELSE',
    '      (SELECT json_group_array(value) FROM json_each(runs.walk) WHERE key < ?)',
    '    END AS signature',
    '  FROM runs',
    ')',
    'SELECT signatures.signature AS "steps",',
    '  COUNT(*) AS sessions,',
    '  AVG(scoped.engaged_ms) AS avg_engaged_ms,',
    // A session "exits" when its last step falls inside the signature — it went no further.
    '  AVG(signatures.total <= ?) AS exit_rate',
    'FROM signatures JOIN scoped ON scoped.sid = signatures.sid',
    'GROUP BY signatures.signature',
    'ORDER BY sessions DESC, signatures.signature',
    'LIMIT ?',
  ].join('\n');
  return { kind: query.kind, sql, params };
}
