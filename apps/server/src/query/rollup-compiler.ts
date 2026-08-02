import {
  type Dimension,
  type FilterLeaf,
  type FilterNode,
  filterLeaves,
  type Metric,
  type SiteWindow,
} from '@featherstat/shared';
import { NO_DIM_ID, ROLLUP_DIMS } from '../rollup/tables.ts';
import {
  boundsCte,
  type CompilableMetricQuery,
  type CompiledQuery,
  type CompiledStatement,
  leafOpSql,
  orderClause,
  routeTable,
  type Table,
  tableBlockers,
} from './compiler.ts';

/**
 * The rollup read path (docs/03 § Rollups): compiles a metric query the planner
 * already approved (`query/planner.ts`) into statements over the rollup tables,
 * in EXACTLY the shape `compileMetricQuery` produces — same `CompiledStatement`
 * fields, same group aliases, same ordering, same bounds CTE consuming the same
 * `boundsParams(windows)` tuples the executor always prepends — so
 * `runCompiled` cannot tell the two stores apart. Each statement's `table`
 * names the RAW side it stands in for, which is what keeps the `measures`
 * header byte-identical to the raw path's (queryMeasures reads it).
 *
 * Anything the planner should have caught throws rather than guessing: this
 * module never refuses a query (the raw path owns honest refusals) and never
 * answers one it cannot answer exactly. The read-equivalence ratchet in
 * `test/replay/` holds the two stores row-for-row equal.
 *
 * Invariant 9 unchanged: dimension ids come from `ROLLUP_DIMS` (a server
 * constant, bound as a parameter anyway) and every client value binds.
 */

const ALIAS = 'r';

/** The three rollup sources; each statement reads exactly one. */
type Source = 'rollup_traffic_hour' | 'rollup_dim_day' | 'rollup_sessions_day';

/** Mirrors the raw compiler's BUCKETS over rollup key columns. `hour` exists
 * only on rollup_traffic_hour; the others are functions of `local_date`. */
const BUCKET_EXPRS = {
  hour: `${ALIAS}.local_date || printf(' %02d:00', ${ALIAS}.local_hour)`,
  day: `${ALIAS}.local_date`,
  week: `date(${ALIAS}.local_date, '+1 day', 'weekday 1', '-7 days')`,
  month: `strftime('%Y-%m', ${ALIAS}.local_date)`,
} as const;

const WEEKDAY_EXPR = `CAST(strftime('%w', ${ALIAS}.local_date) AS INTEGER)`;

/** SQL NULL round-trips through (dim_value = '', dim_null = 1) — this reads it back. */
const DIM_VALUE_EXPR = `CASE WHEN ${ALIAS}.dim_null THEN NULL ELSE ${ALIAS}.dim_value END`;

/**
 * Additive recompositions per raw side (docs/03 § Rollups). Counts COALESCE to
 * 0 so an empty window's total row matches raw's (COUNT over nothing is 0, a
 * bare SUM is NULL); ratios divide sums exactly as the raw ratio aggregations
 * divide — SQLite yields NULL on a zero denominator, the raw path's
 * "no denominator = unknown, never 0" rule for free.
 */
const EVENT_METRIC_SQL: Partial<Record<Metric, string>> = {
  visitors: `COALESCE(SUM(${ALIAS}.visitors), 0)`,
  // Events-routed visits = COUNT(DISTINCT session_id) over actions = the exact
  // per-day sessions_touched (see compiler.ts's note on the visits aggregate).
  visits: `COALESCE(SUM(${ALIAS}.sessions_touched), 0)`,
  pageviews: `COALESCE(SUM(${ALIAS}.pageviews), 0)`,
  events: `COALESCE(SUM(${ALIAS}.events), 0)`,
  outlinks: `COALESCE(SUM(${ALIAS}.outlinks), 0)`,
  downloads: `COALESCE(SUM(${ALIAS}.downloads), 0)`,
  event_value_sum: `COALESCE(SUM(${ALIAS}.event_value_sum), 0)`,
};

const SESSION_METRIC_SQL: Partial<Record<Metric, string>> = {
  visits: `COALESCE(SUM(${ALIAS}.visits), 0)`,
  engaged_sessions: `COALESCE(SUM(${ALIAS}.measured_sessions), 0)`,
  engaged_ms: `COALESCE(SUM(${ALIAS}.engaged_ms), 0)`,
  // Unmeasured sessions carry engaged_ms = 0, so the numerator equals the raw
  // path's sum over measured sessions only.
  avg_engagement: `CAST(SUM(${ALIAS}.engaged_ms) AS REAL) / COALESCE(SUM(${ALIAS}.measured_sessions), 0)`,
  bounce_rate: `CAST(SUM(${ALIAS}.bounced) AS REAL) / COALESCE(SUM(${ALIAS}.visits), 0)`,
  views_per_visit: `CAST(SUM(${ALIAS}.session_pageviews) AS REAL) / COALESCE(SUM(${ALIAS}.visits), 0)`,
};

export function compileRollupMetricQuery(
  query: CompilableMetricQuery,
  globalFilters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledQuery {
  if (query.dim2 !== undefined) throw new Error('a dim2 query reached the rollup compiler');
  const filters = [...globalFilters, ...(query.filters ?? [])];
  const leaves = filters.flatMap(filterLeaves);

  // The single rolled dimension in play (planner rule: at most one), and
  // whether this is an hour shape (rollup_traffic_hour, which has no dim rows).
  const rolledDim = [query.dim, ...leaves.map((leaf) => leaf.dim)].find(
    (dim): dim is Dimension => dim !== undefined && typeof ROLLUP_DIMS[dim] === 'object',
  );
  const hourShape =
    query.bucket === 'hour' ||
    query.dim === 'local_hour' ||
    leaves.some((l) => l.dim === 'local_hour');

  const blockers = tableBlockers(query, filters);
  const metrics = [...new Set(query.metrics)];
  const byTable = new Map<Table, Metric[]>();
  for (const metric of metrics) {
    const table = routeTable(metric, blockers);
    if (table === null) throw new Error(`unanswerable '${metric}' reached the rollup compiler`);
    const assigned = byTable.get(table);
    if (assigned === undefined) byTable.set(table, [metric]);
    else assigned.push(metric);
  }

  const groupKeys: string[] = [];
  if (query.bucket !== undefined) groupKeys.push('bucket');
  if (query.dim !== undefined) groupKeys.push(query.dim);

  const single = byTable.size === 1;
  const statements: CompiledStatement[] = [];
  for (const [table, tableMetrics] of byTable) {
    const source: Source =
      table === 'sessions'
        ? 'rollup_sessions_day'
        : hourShape
          ? 'rollup_traffic_hour'
          : 'rollup_dim_day';
    statements.push(
      buildStatement(source, table, tableMetrics, query, filters, rolledDim, windows, {
        orderAndLimit: single,
        firstMetric: metrics[0],
      }),
    );
  }

  return {
    statements,
    groupKeys,
    metrics,
    hasBucket: query.bucket !== undefined,
    limit: query.limit,
    ordered: single,
    source: 'rollup',
  };
}

interface StatementOptions {
  orderAndLimit: boolean;
  firstMetric: Metric | undefined;
}

function buildStatement(
  source: Source,
  table: Table,
  metrics: readonly Metric[],
  query: CompilableMetricQuery,
  filters: readonly FilterNode[],
  rolledDim: Dimension | undefined,
  windows: readonly SiteWindow[],
  options: StatementOptions,
): CompiledStatement {
  const params: (string | number)[] = [];
  const metricSql = table === 'sessions' ? SESSION_METRIC_SQL : EVENT_METRIC_SQL;

  const select: string[] = [];
  const groupCount = (query.bucket !== undefined ? 1 : 0) + (query.dim !== undefined ? 1 : 0);
  if (query.bucket !== undefined) select.push(`${BUCKET_EXPRS[query.bucket]} AS "bucket"`);
  if (query.dim !== undefined) {
    select.push(`${keyExpr(query.dim, source, rolledDim).sql} AS "${query.dim}"`);
  }
  for (const metric of metrics) {
    const sql = metricSql[metric];
    if (sql === undefined)
      throw new Error(`'${metric}' has no rollup recomposition over ${source}`);
    select.push(`${sql} AS "${metric}"`);
  }

  const where: string[] = [];
  // The dimension-table statements read one rolled group's rows: the query's
  // rolled dimension, or the undimensioned dim_id 0 totals. A server constant,
  // bound anyway (invariant 9's posture).
  if (source !== 'rollup_traffic_hour') {
    where.push(`${ALIAS}.dim_id = ?`);
    params.push(rolledDim === undefined ? NO_DIM_ID : dimIdOf(rolledDim));
  }
  for (const node of filters) where.push(filterNodeSql(node, source, rolledDim, params));

  const lines = [
    boundsCte(windows),
    `SELECT ${select.join(', ')}`,
    `FROM ${source} ${ALIAS} JOIN bounds ON ${ALIAS}.site_id = bounds.site_id
  AND ${ALIAS}.local_date BETWEEN bounds.from_date AND bounds.to_date`,
  ];
  if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`);
  if (groupCount > 0) {
    lines.push(`GROUP BY ${Array.from({ length: groupCount }, (_, i) => i + 1).join(', ')}`);
  }
  if (options.orderAndLimit) {
    const groupKeys: string[] = [];
    if (query.bucket !== undefined) groupKeys.push('bucket');
    if (query.dim !== undefined) groupKeys.push(query.dim);
    const order = orderClause(groupKeys, options.firstMetric);
    if (order !== null) lines.push(order);
    if (query.limit !== undefined) {
      lines.push('LIMIT ?');
      params.push(query.limit);
    }
  }
  return { sql: lines.join('\n'), params, metrics, table };
}

/** A dimension's expression over a rollup source — group key or filter column. */
function keyExpr(
  dim: Dimension,
  source: Source,
  rolledDim: Dimension | undefined,
): { sql: string; numeric: boolean } {
  if (dim === 'site') return { sql: `${ALIAS}.site_id`, numeric: true };
  if (dim === 'weekday') return { sql: WEEKDAY_EXPR, numeric: true };
  if (dim === 'local_hour') {
    if (source !== 'rollup_traffic_hour') {
      throw new Error(`'local_hour' reached ${source}, which has no hour column`);
    }
    return { sql: `${ALIAS}.local_hour`, numeric: true };
  }
  if (dim === rolledDim && source !== 'rollup_traffic_hour') {
    return { sql: DIM_VALUE_EXPR, numeric: false };
  }
  throw new Error(`'${dim}' has no expression over ${source}`);
}

function dimIdOf(dim: Dimension): number {
  const entry = ROLLUP_DIMS[dim];
  if (typeof entry !== 'object') throw new Error(`'${dim}' is not a rolled dimension`);
  return entry.dimId;
}

/**
 * The raw compiler's `filterNodeSql`, over rollup columns: same composition,
 * same NULL-safe negation (`NOT COALESCE(…, 0)` admits the dim_null row), and
 * the op semantics shared verbatim through `leafOpSql`. Filtering the rolled
 * dimension is sound because its rows PARTITION the raw rows: a predicate over
 * `dim_value` keeps or drops whole groups, exactly as the raw WHERE keeps or
 * drops their member rows.
 */
function filterNodeSql(
  node: FilterNode,
  source: Source,
  rolledDim: Dimension | undefined,
  params: (string | number)[],
): string {
  if ('all' in node) {
    return `(${node.all.map((child) => filterNodeSql(child, source, rolledDim, params)).join(' AND ')})`;
  }
  if ('any' in node) {
    return `(${node.any.map((child) => filterNodeSql(child, source, rolledDim, params)).join(' OR ')})`;
  }
  if ('not' in node) {
    return `NOT COALESCE((${filterNodeSql(node.not, source, rolledDim, params)}), 0)`;
  }
  if ('segment' in node) {
    throw new Error(`segment ref ${node.segment} reached the rollup compiler unexpanded`);
  }
  return leafSql(node, source, rolledDim, params);
}

function leafSql(
  leaf: FilterLeaf,
  source: Source,
  rolledDim: Dimension | undefined,
  params: (string | number)[],
): string {
  const column = keyExpr(leaf.dim, source, rolledDim);
  return leafOpSql(column.sql, leaf, params, column.numeric);
}
