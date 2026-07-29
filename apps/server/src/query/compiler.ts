import {
  type Bucket,
  type Dimension,
  ENGAGEMENT_THRESHOLD_MS,
  type Filter,
  type Metric,
  type MetricQuery,
} from '@featherstat/shared';

/**
 * MetricQuery → parameterized SQL (CLAUDE.md invariant 7). Every identifier comes
 * from the vocabulary tables below and every client value is a bound parameter —
 * the request can never smuggle SQL.
 *
 * Table routing (docs/04 § 3): session-shaped metrics (visits, engaged_ms,
 * bounce_rate, views_per_visit) aggregate over `sessions`; event-shaped metrics
 * (visitors, pageviews, events, event_value_sum) over `events`. Both tables are
 * denormalized with device/geo/attribution, so most queries compile to a single
 * statement; a query mixing both shapes compiles to one statement per table and
 * the executor merges rows on the group key. A combination the vocabulary cannot
 * answer honestly (e.g. bounce_rate × title) compiles to an error entry — never
 * a wrong number.
 *
 * Every statement scopes rows through a per-site bounds CTE — `(site_id, from,
 * to)` tuples bound at execution — because presets resolve per site timezone
 * (see ranges.ts) and `site: "all"` needs one window per site.
 */

type Table = 'events' | 'sessions';

interface DimSpec {
  events: string;
  sessions: string | null;
  /** Digit-string filter values bind as numbers, so expression dims compare correctly. */
  numeric?: boolean;
}

/** `strftime('%w')`: 0 = Sunday … 6 = Saturday. */
function weekdayExpr(alias: string): string {
  return `CAST(strftime('%w', ${alias}.local_date) AS INTEGER)`;
}

const DIMS: Record<Dimension, DimSpec> = {
  path: { events: 'e.path', sessions: null },
  hostname: { events: 'e.hostname', sessions: null },
  title: { events: 'e.title', sessions: null },
  target_url: { events: 'e.target_url', sessions: null },
  ref_domain: { events: 'e.ref_domain', sessions: 's.ref_domain' },
  ref_type: { events: 'e.ref_type', sessions: 's.ref_type' },
  utm_source: { events: 'e.utm_source', sessions: 's.utm_source' },
  utm_medium: { events: 'e.utm_medium', sessions: 's.utm_medium' },
  utm_campaign: { events: 'e.utm_campaign', sessions: 's.utm_campaign' },
  country: { events: 'e.country', sessions: 's.country' },
  region: { events: 'e.region', sessions: 's.region' },
  city: { events: 'e.city', sessions: 's.city' },
  browser: { events: 'e.browser', sessions: 's.browser' },
  os: { events: 'e.os', sessions: 's.os' },
  device_type: { events: 'e.device_type', sessions: 's.device_type' },
  screen: { events: 'e.screen', sessions: null },
  lang: { events: 'e.lang', sessions: null },
  event_category: { events: 'e.event_category', sessions: null },
  event_action: { events: 'e.event_action', sessions: null },
  event_name: { events: 'e.event_name', sessions: null },
  local_hour: { events: 'e.local_hour', sessions: null, numeric: true },
  weekday: { events: weekdayExpr('e'), sessions: weekdayExpr('s'), numeric: true },
  site: { events: 'e.site_id', sessions: 's.site_id', numeric: true },
};

/** Monday of the date's week: Sunday belongs to the week that started the previous Monday. */
function weekExpr(alias: string): string {
  return `date(${alias}.local_date, '+1 day', 'weekday 1', '-7 days')`;
}

/** `hour` needs `local_hour`, which only events carry. */
const BUCKETS: Record<Bucket, { events: string; sessions: string | null }> = {
  hour: { events: "e.local_date || printf(' %02d:00', e.local_hour)", sessions: null },
  day: { events: 'e.local_date', sessions: 's.local_date' },
  week: { events: weekExpr('e'), sessions: weekExpr('s') },
  month: { events: "strftime('%Y-%m', e.local_date)", sessions: "strftime('%Y-%m', s.local_date)" },
};

interface MetricExpr {
  sql: string;
  /** Bound in SELECT-list order, ahead of any WHERE params. */
  params?: readonly number[];
}

interface MetricSpec {
  preferred: Table;
  events?: MetricExpr;
  sessions?: MetricExpr;
  /** This metric's value for a group one side of a merged query returned no row for. */
  empty: 0 | null;
}

const METRICS: Record<Metric, MetricSpec> = {
  /**
   * docs/03: distinct visitor ids over the window's stored hits — always
   * events, never session starts. Heartbeats are excluded: a ping is a
   * continuation signal, not a visit, and a session that beats past local
   * midnight would otherwise book a visitor into a day they never acted in.
   * That produced the impossible reading `pageviews < visitors`.
   */
  visitors: {
    preferred: 'events',
    events: { sql: "COUNT(DISTINCT CASE WHEN e.type != 'ping' THEN e.visitor_id END)" },
    empty: 0,
  },
  /**
   * Visits with time on the clock. A single-hit visit is unmeasurable, not
   * zero-length: nothing followed it, so no gap exists to accrue. Averaging
   * engaged time over ALL visits therefore reports the measurement gap as
   * brevity — the same dishonesty the dwell card refuses (docs/03, docs/04).
   */
  engaged_sessions: {
    preferred: 'sessions',
    // A count of a subset is 0 when the subset is empty, never unknown — a bare
    // SUM over no rows is NULL, which would contradict this metric's own `empty`.
    sessions: { sql: 'COALESCE(SUM(CASE WHEN s.engaged_ms > 0 THEN 1 ELSE 0 END), 0)' },
    empty: 0,
  },
  visits: {
    preferred: 'sessions',
    sessions: { sql: 'COUNT(*)' },
    /**
     * With an event-level dimension in play this is the count of sessions in the
     * group — over the same non-ping population `visitors` uses. Counting
     * heartbeats here instead would let a group report visits whose visitors were
     * never counted and whose rows record no action at all: a visit that did
     * nothing, in a group it only beat in.
     */
    events: { sql: "COUNT(DISTINCT CASE WHEN e.type != 'ping' THEN e.session_id END)" },
    empty: 0,
  },
  pageviews: {
    preferred: 'events',
    events: { sql: "COALESCE(SUM(e.type = 'pageview'), 0)" },
    empty: 0,
  },
  events: { preferred: 'events', events: { sql: "COALESCE(SUM(e.type = 'event'), 0)" }, empty: 0 },
  outlinks: {
    preferred: 'events',
    events: { sql: "COALESCE(SUM(e.type = 'outlink'), 0)" },
    empty: 0,
  },
  downloads: {
    preferred: 'events',
    events: { sql: "COALESCE(SUM(e.type = 'download'), 0)" },
    empty: 0,
  },
  engaged_ms: {
    preferred: 'sessions',
    sessions: { sql: 'COALESCE(SUM(s.engaged_ms), 0)' },
    empty: 0,
  },
  bounce_rate: {
    preferred: 'sessions',
    // Engagement-aware (docs/03, CLAUDE.md invariant 5); the threshold is bound, never inlined.
    sessions: {
      sql: 'AVG(s.pageviews = 1 AND s.events = 0 AND s.engaged_ms < ?)',
      params: [ENGAGEMENT_THRESHOLD_MS],
    },
    empty: null,
  },
  views_per_visit: {
    preferred: 'sessions',
    sessions: { sql: 'CAST(SUM(s.pageviews) AS REAL) / COUNT(*)' },
    empty: null,
  },
  event_value_sum: {
    preferred: 'events',
    events: { sql: "COALESCE(SUM(CASE WHEN e.type = 'event' THEN e.event_value END), 0)" },
    empty: 0,
  },
};

export function metricEmpty(metric: Metric): 0 | null {
  return METRICS[metric].empty;
}

/** True when only the events table carries `dim` — sessions cannot be filtered by it. */
export function eventOnlyDimension(dim: Dimension): boolean {
  return DIMS[dim].sessions === null;
}

/** The per-site scope every statement joins through: `(site_id, from, to)` tuples bound at execution. */
export function boundsCte(siteCount: number): string {
  const tuples = Array.from({ length: siteCount }, () => '(?, ?, ?)').join(', ');
  return `WITH bounds(site_id, from_date, to_date) AS (VALUES ${tuples})`;
}

export interface CompiledStatement {
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order (SELECT, WHERE, LIMIT). */
  params: readonly (string | number)[];
  /** The metrics this statement answers; each is aliased to its own name in the row. */
  metrics: readonly Metric[];
  /** The routing decision: which table this statement aggregates over. */
  table: Table;
}

export interface CompiledQuery {
  statements: readonly CompiledStatement[];
  /** Output columns identifying a group, bucket first; empty for plain totals. */
  groupKeys: readonly string[];
  metrics: readonly Metric[];
  hasBucket: boolean;
  limit: number | undefined;
  /** True when the single statement already ordered and limited in SQL; merged queries sort in JS. */
  ordered: boolean;
}

export interface CompileError {
  error: { code: 'unsupported'; message: string };
}

interface Group {
  key: string;
  events: string;
  sessions: string | null;
}

export function compileMetricQuery(
  query: MetricQuery,
  globalFilters: readonly Filter[],
  siteCount: number,
): CompiledQuery | CompileError {
  const filters = [...globalFilters, ...(query.filters ?? [])];
  for (const filter of filters) {
    if (filter.op !== 'in' && Array.isArray(filter.value)) {
      return unsupported(`filter op '${filter.op}' on '${filter.dim}' expects a single value`);
    }
  }

  const groups: Group[] = [];
  if (query.bucket !== undefined) groups.push({ key: 'bucket', ...BUCKETS[query.bucket] });
  for (const dim of [query.dim, query.dim2]) {
    if (dim !== undefined) groups.push({ key: dim, ...DIMS[dim] });
  }

  // Sessions become unusable as soon as any group or filter needs an event-level column.
  let sessionsBlocker: string | undefined;
  for (const group of groups) {
    if (group.sessions === null) sessionsBlocker ??= group.key;
  }
  for (const filter of filters) {
    if (DIMS[filter.dim].sessions === null) sessionsBlocker ??= filter.dim;
  }

  const metrics = [...new Set(query.metrics)];
  const byTable = new Map<Table, Metric[]>();
  for (const metric of metrics) {
    const table = pickTable(METRICS[metric], sessionsBlocker === undefined);
    if (table === null) {
      return unsupported(
        `'${metric}' is a session-level metric and cannot be combined with '${sessionsBlocker}'`,
      );
    }
    const assigned = byTable.get(table);
    if (assigned === undefined) byTable.set(table, [metric]);
    else assigned.push(metric);
  }

  const single = byTable.size === 1;
  const statements: CompiledStatement[] = [];
  for (const [table, tableMetrics] of byTable) {
    statements.push(
      buildStatement(table, tableMetrics, groups, filters, siteCount, {
        orderAndLimit: single,
        firstMetric: metrics[0],
        limit: query.limit,
      }),
    );
  }

  return {
    statements,
    groupKeys: groups.map((group) => group.key),
    metrics,
    hasBucket: query.bucket !== undefined,
    limit: query.limit,
    ordered: single,
  };
}

export function unsupported(message: string): CompileError {
  return { error: { code: 'unsupported', message } };
}

function pickTable(spec: MetricSpec, sessionsUsable: boolean): Table | null {
  const order: readonly Table[] =
    spec.preferred === 'events' ? ['events', 'sessions'] : ['sessions', 'events'];
  for (const table of order) {
    if (spec[table] === undefined) continue;
    if (table === 'sessions' && !sessionsUsable) continue;
    return table;
  }
  return null;
}

interface StatementOptions {
  orderAndLimit: boolean;
  firstMetric: Metric | undefined;
  limit: number | undefined;
}

function buildStatement(
  table: Table,
  metrics: readonly Metric[],
  groups: readonly Group[],
  filters: readonly Filter[],
  siteCount: number,
  options: StatementOptions,
): CompiledStatement {
  const alias = table === 'events' ? 'e' : 's';
  const params: (string | number)[] = [];

  const select: string[] = [];
  for (const group of groups) {
    select.push(`${table === 'events' ? group.events : group.sessions} AS "${group.key}"`);
  }
  for (const metric of metrics) {
    const expr = METRICS[metric][table];
    if (expr === undefined) throw new Error(`'${metric}' was routed to a table it cannot answer`);
    select.push(`${expr.sql} AS "${metric}"`);
    if (expr.params !== undefined) params.push(...expr.params);
  }

  const where = filters.map((filter) => filterSql(filter, table, params));

  const lines = [
    boundsCte(siteCount),
    `SELECT ${select.join(', ')}`,
    `FROM ${table} ${alias} JOIN bounds ON ${alias}.site_id = bounds.site_id`,
    `  AND ${alias}.local_date BETWEEN bounds.from_date AND bounds.to_date`,
  ];
  if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`);
  if (groups.length > 0) lines.push(`GROUP BY ${groups.map((_, i) => i + 1).join(', ')}`);
  if (options.orderAndLimit) {
    const order = orderClause(groups, options.firstMetric);
    if (order !== null) lines.push(order);
    if (options.limit !== undefined) {
      lines.push('LIMIT ?');
      params.push(options.limit);
    }
  }
  return { sql: lines.join('\n'), params, metrics, table };
}

/** Buckets read in time order; breakdowns lead with the first metric, ties in group order. */
function orderClause(groups: readonly Group[], firstMetric: Metric | undefined): string | null {
  if (groups.length === 0 || firstMetric === undefined) return null;
  if (groups[0]?.key === 'bucket') {
    return groups.length === 1 ? 'ORDER BY 1' : `ORDER BY 1, "${firstMetric}" DESC`;
  }
  return `ORDER BY "${firstMetric}" DESC, 1`;
}

export function filterSql(filter: Filter, table: Table, params: (string | number)[]): string {
  const spec = DIMS[filter.dim];
  const column = table === 'events' ? spec.events : spec.sessions;
  if (column === null) throw new Error(`'${filter.dim}' filter reached a table without it`);
  const bind = (value: string): string | number =>
    spec.numeric === true && /^-?\d+$/.test(value) ? Number(value) : value;

  switch (filter.op) {
    case 'is_null':
      // The NULL group a breakdown returns (e.g. direct traffic) — `=` can never match it.
      return `${column} IS NULL`;
    case 'eq':
      params.push(bind(filter.value as string));
      return `${column} = ?`;
    case 'neq':
      // IS NOT: rows where the dimension is NULL also differ from the value.
      params.push(bind(filter.value as string));
      return `${column} IS NOT ?`;
    case 'in': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value as string];
      if (values.length === 0) return '1 = 0';
      for (const value of values) params.push(bind(value));
      return `${column} IN (${values.map(() => '?').join(', ')})`;
    }
    case 'contains':
      params.push(`%${escapeLike(filter.value as string)}%`);
      return `${column} LIKE ? ESCAPE '\\'`;
    case 'starts':
      params.push(`${escapeLike(filter.value as string)}%`);
      return `${column} LIKE ? ESCAPE '\\'`;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
