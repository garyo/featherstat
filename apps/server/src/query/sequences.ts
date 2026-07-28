import type { Filter, SequenceQuery } from '@analytics/shared';
import {
  boundsCte,
  type CompileError,
  eventOnlyDimension,
  filterSql,
  unsupported,
} from './compiler.ts';

/**
 * SequenceQuery → parameterized SQL (docs/03 § Journeys, docs/04 § 3). Sequence
 * queries are session-scoped: the batch envelope picks sessions (site, the
 * session's `local_date` against the range, session-level filters), and every
 * non-ping event of a picked session participates — including rows stored past
 * midnight, so a journey is never truncated at a date boundary. A filter only
 * the events table can answer (path, event_category, …) cannot honestly scope
 * a whole session and compiles to an error entry, like the metric path.
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
  for (const filter of filters) {
    if (filter.op !== 'in' && Array.isArray(filter.value)) {
      return unsupported(`filter op '${filter.op}' on '${filter.dim}' expects a single value`);
    }
    if (eventOnlyDimension(filter.dim)) {
      return unsupported(
        `sequence queries are session-scoped and cannot honestly apply the event-level filter '${filter.dim}'`,
      );
    }
  }

  const params: (string | number)[] = [];
  const where = filters.map((filter) => filterSql(filter, 'sessions', params));
  const scoped = [
    'scoped AS (',
    `  SELECT s.id AS sid${query.kind === 'flows' ? ', s.engaged_ms AS engaged_ms' : ''}`,
    '  FROM sessions s JOIN bounds ON s.site_id = bounds.site_id',
    '    AND s.local_date BETWEEN bounds.from_date AND bounds.to_date',
    ...(where.length > 0 ? [`  WHERE ${where.join(' AND ')}`] : []),
    ')',
  ].join('\n');
  const labeled = [
    '(',
    `    SELECT e.session_id AS sid, e.seq AS seq, ${LABEL} AS label`,
    '    FROM events e JOIN scoped ON e.session_id = scoped.sid',
    "    WHERE e.type <> 'ping'",
    '  )',
  ].join('\n');

  if (query.kind === 'transitions') {
    // One edge per session per step; `limit` keeps the top edges of every step,
    // so a deep layer is never starved by a busy entry layer.
    params.push(query.steps, query.limit);
    const sql = [
      `${boundsCte(siteCount)},`,
      `${scoped},`,
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
    `${boundsCte(siteCount)},`,
    `${scoped},`,
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
