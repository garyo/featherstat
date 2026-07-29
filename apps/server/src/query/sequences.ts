import type { Filter, SequenceQuery } from '@featherstat/shared';
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
 */

export interface CompiledSequence {
  kind: SequenceQuery['kind'];
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
}

/** NULL never labels a step: a title-only pageview (no URL) reads as ''. */
const LABEL = `COALESCE(CASE WHEN e.type = 'event'
        THEN 'event: ' || e.event_category || ' · ' || e.event_action
        ELSE e.path END, '')`;

export function compileSequenceQuery(
  query: SequenceQuery,
  filters: readonly Filter[],
  siteCount: number,
): CompiledSequence | CompileError {
  const scope = sessionScope(
    'sequence queries',
    filters,
    siteCount,
    query.kind === 'flows' ? ['s.engaged_ms AS engaged_ms'] : [],
  );
  if ('error' in scope) return scope;

  const { params } = scope;
  const labeled = [
    '(',
    `    SELECT e.session_id AS sid, e.seq AS seq, ${LABEL} AS label`,
    '    FROM events e JOIN scoped ON e.session_id = scoped.sid',
    // A journey is what the visitor DID: the `actions` population, so a
    // heartbeat never becomes a step.
    `    WHERE ${populationWhere('actions', 'e')}`,
    '  )',
  ].join('\n');

  if (query.kind === 'transitions') {
    // One edge per session per step; `limit` keeps the top edges of every step,
    // so a deep layer is never starved by a busy entry layer.
    params.push(query.steps, query.limit);
    const sql = [
      `${scope.sql},`,
      'walked AS (',
      '  SELECT ROW_NUMBER() OVER w AS step, label, LEAD(label) OVER w AS next',
      `  FROM ${labeled}`,
      '  WINDOW w AS (PARTITION BY sid ORDER BY seq)',
      '),',
      'edges AS (',
      '  SELECT step, label AS "from", next AS "to", COUNT(*) AS sessions',
      '  FROM walked WHERE next IS NOT NULL AND step <= ?',
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

  params.push(query.steps, query.steps, query.limit);
  const sql = [
    `${scope.sql},`,
    'positioned AS (',
    '  SELECT sid, label, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY seq) AS pos',
    `  FROM ${labeled}`,
    '),',
    'signatures AS (',
    '  SELECT sid,',
    '    json_group_array(label ORDER BY pos) FILTER (WHERE pos <= ?) AS signature,',
    '    MAX(pos) AS total',
    '  FROM positioned GROUP BY sid',
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
