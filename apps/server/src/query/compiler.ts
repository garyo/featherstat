import {
  type Bucket,
  type Dimension,
  ENGAGEMENT_THRESHOLD_MS,
  type Filter,
  type Measure,
  type MeasureComponents,
  type Measures,
  type Metric,
  type MetricQuery,
  type Population,
  type SiteWindow,
  type Unit,
} from '@featherstat/shared';
import { populationSql } from './population.ts';

/**
 * MetricQuery → parameterized SQL (CLAUDE.md invariant 9). Every identifier comes
 * from the vocabulary tables below and every client value is a bound parameter —
 * the request can never smuggle SQL.
 *
 * A metric declares three things and writes no SQL of its own: the **population**
 * whose rows it draws from (docs/03 § Populations, named in `packages/shared`),
 * what it does with them, and its **unit**. The two compose into an expression
 * below, and travel back to the client as the result's `measures` header
 * (docs/04 § 3) so nothing downstream has to guess how two numbers combine.
 * Before that, the predicate was whatever each metric's author typed, and
 * `visitors` and `visits` silently disagreed about heartbeats.
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

export type Table = 'events' | 'sessions';

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

/**
 * What a metric does with its population's rows. The population says WHICH rows;
 * this says what to do with them, and the two compose into SQL below — no metric
 * writes a row predicate of its own, which is how `visitors` and `visits` came
 * to disagree about heartbeats.
 */
type Aggregation =
  | { kind: 'rows' }
  | { kind: 'distinct'; column: string }
  | { kind: 'sum'; value: string }
  | {
      kind: 'ratio';
      /** Summed over the population; the denominator is always its row count. */
      numerator: string;
      params?: readonly number[];
      of: MeasureComponents;
    };

/** How one table answers one metric. */
interface TableSpec {
  population: Population;
  aggregation: Aggregation;
}

interface MetricSpec {
  preferred: Table;
  unit: Unit;
  events?: TableSpec;
  sessions?: TableSpec;
  /** This metric's value for a group one side of a merged query returned no row for. */
  empty: 0 | null;
}

const METRICS: Record<Metric, MetricSpec> = {
  /**
   * docs/03: distinct visitor ids over the window's stored hits — always
   * events, never session starts. The `actions` population excludes heartbeats:
   * a ping is a continuation signal, not a visit, and a session that beats past
   * local midnight would otherwise book a visitor into a day they never acted
   * in. That produced the impossible reading `pageviews < visitors`. Realtime's
   * "active now" deliberately counts `presence` instead (realtime/hub.ts): a
   * reader holding a tab open IS here, they just have not done anything.
   */
  visitors: {
    preferred: 'events',
    unit: 'count',
    events: { population: 'actions', aggregation: { kind: 'distinct', column: 'e.visitor_id' } },
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
    unit: 'count',
    sessions: { population: 'measured_sessions', aggregation: { kind: 'rows' } },
    empty: 0,
  },
  visits: {
    preferred: 'sessions',
    unit: 'count',
    sessions: { population: 'sessions', aggregation: { kind: 'rows' } },
    /**
     * With an event-level dimension in play this is the count of sessions in the
     * group — over the same `actions` population `visitors` uses. Counting
     * heartbeats here instead would let a group report visits whose visitors were
     * never counted and whose rows record no action at all: a visit that did
     * nothing, in a group it only beat in. Note the aggregate differs with the
     * table, and the result's `measures` header says which one answered.
     */
    events: { population: 'actions', aggregation: { kind: 'distinct', column: 'e.session_id' } },
    empty: 0,
  },
  pageviews: {
    preferred: 'events',
    unit: 'count',
    events: { population: 'pageviews', aggregation: { kind: 'rows' } },
    empty: 0,
  },
  events: {
    preferred: 'events',
    unit: 'count',
    events: { population: 'events', aggregation: { kind: 'rows' } },
    empty: 0,
  },
  outlinks: {
    preferred: 'events',
    unit: 'count',
    events: { population: 'outlinks', aggregation: { kind: 'rows' } },
    empty: 0,
  },
  downloads: {
    preferred: 'events',
    unit: 'count',
    events: { population: 'downloads', aggregation: { kind: 'rows' } },
    empty: 0,
  },
  engaged_ms: {
    preferred: 'sessions',
    unit: 'ms',
    sessions: { population: 'sessions', aggregation: { kind: 'sum', value: 's.engaged_ms' } },
    empty: 0,
  },
  /**
   * Engaged time per MEASURED visit — the tile's number, computed where the
   * population is known. The client used to divide `engaged_ms` by
   * `engaged_sessions` itself, in two places with different null semantics; the
   * `of` components are what let a sparkline re-derive it over a slice without
   * averaging an average.
   */
  avg_engagement: {
    preferred: 'sessions',
    unit: 'ms',
    sessions: {
      population: 'measured_sessions',
      aggregation: {
        kind: 'ratio',
        numerator: 's.engaged_ms',
        of: { numerator: 'engaged_ms', denominator: 'engaged_sessions' },
      },
    },
    // No measured visit is "unknown", never 0 s — the measurement gap again.
    empty: null,
  },
  bounce_rate: {
    preferred: 'sessions',
    unit: 'rate',
    sessions: {
      population: 'sessions',
      aggregation: {
        // Engagement-aware (docs/03, CLAUDE.md invariant 5); the threshold is
        // bound, never inlined — it is configurable, unlike a hit type.
        kind: 'ratio',
        numerator: '(s.pageviews = 1 AND s.events = 0 AND s.engaged_ms < ?)',
        params: [ENGAGEMENT_THRESHOLD_MS],
        // A rate in 0–1, and no metric names the bounced visits it counts, so
        // the reduction re-weights on the denominator instead.
        of: { denominator: 'visits' },
      },
    },
    empty: null,
  },
  views_per_visit: {
    preferred: 'sessions',
    unit: 'value',
    sessions: {
      population: 'sessions',
      // The numerator is the visit's own pageview counter, which is dated by
      // where the visit STARTED — not the `pageviews` metric, dated by when each
      // row happened. They differ across a local midnight, so no numerator is
      // named and the reduction re-weights on visits.
      aggregation: { kind: 'ratio', numerator: 's.pageviews', of: { denominator: 'visits' } },
    },
    empty: null,
  },
  event_value_sum: {
    preferred: 'events',
    unit: 'value',
    events: { population: 'events', aggregation: { kind: 'sum', value: 'e.event_value' } },
    empty: 0,
  },
};

export function metricEmpty(metric: Metric): 0 | null {
  return METRICS[metric].empty;
}

/**
 * What a metric means once the router has picked a table — the wire's `measures`
 * entry (docs/04 § 3). Table-dependent on purpose: `visits` is an additive count
 * of session rows, and a distinct count of session ids once an event-level
 * dimension forces it onto the events table. A client that re-aggregates has to
 * be told which it got.
 */
export function measureOf(metric: Metric, table: Table): Measure {
  const spec = METRICS[metric];
  const tableSpec = spec[table];
  if (tableSpec === undefined) {
    throw new Error(`'${metric}' has no definition over '${table}'`);
  }
  const aggregation = tableSpec.aggregation;
  return {
    unit: spec.unit,
    population: tableSpec.population,
    aggregate: aggregation.kind === 'rows' ? 'sum' : aggregation.kind,
    ...(aggregation.kind === 'ratio' ? { of: aggregation.of } : {}),
  };
}

/** The tables a metric can be answered from, its preference first. */
export function metricTables(metric: Metric): readonly Table[] {
  const spec = METRICS[metric];
  return tableOrder(spec).filter((table) => spec[table] !== undefined);
}

/** The table a metric is answered from when nothing blocks its preference. */
export function preferredTable(metric: Metric): Table {
  const table = metricTables(metric)[0];
  if (table === undefined) throw new Error(`'${metric}' has no table at all`);
  return table;
}

function tableOrder(spec: MetricSpec): readonly Table[] {
  return spec.preferred === 'events' ? ['events', 'sessions'] : ['sessions', 'events'];
}

/** The measures header for a compiled query: one entry per metric, as routed. */
export function queryMeasures(compiled: CompiledQuery): Measures {
  const measures: Measures = {};
  for (const statement of compiled.statements) {
    for (const metric of statement.metrics) measures[metric] = measureOf(metric, statement.table);
  }
  return measures;
}

/**
 * A metric's SELECT expression: its aggregation composed over its population's
 * rows, as a `CASE WHEN`.
 *
 * A CASE and not a WHERE, because one statement answers metrics of MIXED
 * population — `visitors` over `actions` beside `pageviews` over its own — and a
 * filtered row set could only serve one of them.
 */
function metricSql(spec: TableSpec, alias: string): { sql: string; params: readonly number[] } {
  const predicate = populationSql(spec.population, alias);
  const only = (value: string): string =>
    predicate === null ? value : `CASE WHEN ${predicate} THEN ${value} END`;
  // A count of a subset is 0 when the subset is empty, never unknown — a bare
  // SUM over no rows is NULL, which would contradict a count metric's `empty`.
  const rows =
    predicate === null ? 'COUNT(*)' : `COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0)`;

  const aggregation = spec.aggregation;
  switch (aggregation.kind) {
    case 'rows':
      return { sql: rows, params: [] };
    case 'distinct':
      return { sql: `COUNT(DISTINCT ${only(aggregation.column)})`, params: [] };
    case 'sum':
      return { sql: `COALESCE(SUM(${only(aggregation.value)}), 0)`, params: [] };
    case 'ratio':
      // NULL over an empty population — a rate with no denominator is unknown,
      // and 0 would be a fabricated answer.
      return {
        sql: `CAST(SUM(${only(aggregation.numerator)}) AS REAL) / ${rows}`,
        params: aggregation.params ?? [],
      };
  }
}

/** True when only the events table carries `dim` — sessions cannot be filtered by it. */
export function eventOnlyDimension(dim: Dimension): boolean {
  return DIMS[dim].sessions === null;
}

const DATE_BOUNDS = ['site_id', 'from_date', 'to_date'] as const;
const ROLLING_BOUNDS = [...DATE_BOUNDS, 'from_ts', 'to_ts'] as const;

/** UTC-ms column each table is dated by; a session is dated by where it STARTED. */
const TS_COLUMN: Record<Table, string> = { events: 'ts', sessions: 'started_at' };

/** Every window in a request resolves from one range, so one of them answers for all. */
function isRolling(windows: readonly SiteWindow[]): boolean {
  return windows[0]?.fromTs !== undefined;
}

/**
 * The per-site scope every statement joins through: `(site_id, from_date,
 * to_date)` tuples bound at execution, plus `(from_ts, to_ts)` for a rolling
 * window, whose edges fall inside a local date (ranges.ts).
 *
 * Date-granular presets emit exactly the SQL they always did. The refinement
 * costs a comparison per candidate row, and a window that covers whole local
 * dates has nothing to refine — 90 days of rows must not pay for a preset they
 * are not.
 */
export function boundsCte(windows: readonly SiteWindow[]): string {
  const columns = isRolling(windows) ? ROLLING_BOUNDS : DATE_BOUNDS;
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  const tuples = Array.from({ length: windows.length }, () => tuple).join(', ');
  return `WITH bounds(${columns.join(', ')}) AS (VALUES ${tuples})`;
}

/**
 * The join predicate scoping one table to those bounds. `local_date` does the
 * index work either way (it is the dates the span touches); the instants trim
 * the two partial dates at the ends down to the hour.
 */
export function boundsJoin(table: Table, windows: readonly SiteWindow[]): string {
  const alias = table === 'events' ? 'e' : 's';
  const scope = [
    `${alias}.site_id = bounds.site_id`,
    `${alias}.local_date BETWEEN bounds.from_date AND bounds.to_date`,
  ];
  if (isRolling(windows)) {
    const ts = `${alias}.${TS_COLUMN[table]}`;
    scope.push(`${ts} >= bounds.from_ts`, `${ts} < bounds.to_ts`);
  }
  return `${table} ${alias} JOIN bounds ON ${scope.join('\n  AND ')}`;
}

/** The values those tuples bind, in column order — the other half of `boundsCte`. */
export function boundsParams(windows: readonly SiteWindow[]): (string | number)[] {
  const rolling = isRolling(windows);
  const params: (string | number)[] = [];
  for (const window of windows) {
    params.push(window.siteId, window.from, window.to);
    if (rolling) params.push(window.fromTs ?? 0, window.toTs ?? Number.MAX_SAFE_INTEGER);
  }
  return params;
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
  windows: readonly SiteWindow[],
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
      buildStatement(table, tableMetrics, groups, filters, windows, {
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
  for (const table of tableOrder(spec)) {
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
  windows: readonly SiteWindow[],
  options: StatementOptions,
): CompiledStatement {
  const alias = table === 'events' ? 'e' : 's';
  const params: (string | number)[] = [];

  const select: string[] = [];
  for (const group of groups) {
    select.push(`${table === 'events' ? group.events : group.sessions} AS "${group.key}"`);
  }
  for (const metric of metrics) {
    const spec = METRICS[metric][table];
    if (spec === undefined) throw new Error(`'${metric}' was routed to a table it cannot answer`);
    const expr = metricSql(spec, alias);
    select.push(`${expr.sql} AS "${metric}"`);
    params.push(...expr.params);
  }

  const where = filters.map((filter) => filterSql(filter, table, params));

  const lines = [
    boundsCte(windows),
    `SELECT ${select.join(', ')}`,
    `FROM ${boundsJoin(table, windows)}`,
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
