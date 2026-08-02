import { type FilterNode, filterLeaves, type SiteWindow } from '@featherstat/shared';
import {
  boundsCte,
  boundsJoin,
  type CompileError,
  eventOnlyDimension,
  filterNodeSql,
  invalidLeaf,
  unsupported,
} from './compiler.ts';

/**
 * The envelope shared by the query kinds that don't fit metric × dimension
 * (journeys in sequences.ts, time on page in dwell.ts). The batch scope picks
 * SESSIONS — site, the session's `local_date` against the range, session-level
 * filters — and every event of a picked session then participates, including
 * rows stored past midnight, so a session is never truncated at a date
 * boundary. A filter only the events table can answer (path, event_category, …)
 * cannot honestly scope a whole session and compiles to an error entry, exactly
 * like the metric path refuses a session metric under an event-level dimension.
 */
export interface SessionScope {
  /** `WITH bounds(…) AS (VALUES …), scoped AS (…)`; the caller appends its own CTEs. */
  sql: string;
  /** Bound after the per-site bounds tuples: filter values come first in textual order. */
  params: (string | number)[];
}

export function sessionScope(
  /** Names the asking kind (plural) in the refusal message: "<subject> are session-scoped …". */
  subject: string,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
  /** Extra session columns a kind needs downstream, e.g. `s.engaged_ms AS engaged_ms`. */
  columns: readonly string[] = [],
): SessionScope | CompileError {
  const leaves = filters.flatMap(filterLeaves);
  const invalid = invalidLeaf(leaves);
  if (invalid !== undefined) return invalid;
  for (const leaf of leaves) {
    // A session-scoped leaf asks about the session's own events — that is
    // honest here; only a HIT-scoped event-level predicate has no session answer.
    if (leaf.scope !== 'session' && eventOnlyDimension(leaf.dim)) {
      return unsupported(
        `${subject} are session-scoped and cannot honestly apply the event-level filter '${leaf.dim}'`,
      );
    }
  }

  const params: (string | number)[] = [];
  const where = filters.map((node) => filterNodeSql(node, 'sessions', windows, params));
  const sql = [
    `${boundsCte(windows)},`,
    'scoped AS (',
    `  SELECT ${['s.id AS sid', ...columns].join(', ')}`,
    `  FROM ${boundsJoin('sessions', windows)}`,
    ...(where.length > 0 ? [`  WHERE ${where.join(' AND ')}`] : []),
    ')',
  ].join('\n');
  return { sql, params };
}
