import {
  type DerivedAst,
  derivedMetricsOf,
  derivedNameOf,
  evaluateDerived,
  type FilterNode,
  isDerivedMetricRef,
  isGoalMetricRef,
  isQueryError,
  localClock,
  MAX_METRICS_PER_QUERY,
  type Measure,
  type Measures,
  type Metric,
  type MetricQuery,
  parseDerivedExpr,
  type QueryErrorResult,
  type QueryRequest,
  type QueryResponse,
  type QueryResult,
  type Range,
  type ResultRow,
  type SiteWindow,
  type Unit,
} from '@featherstat/shared';
import {
  type Db,
  dataVersion,
  getSite,
  listSites,
  type Site,
  stmt,
  withReadSnapshot,
} from '../db/index.ts';
import { rawHorizonTs, rollupNeedsRebuild } from '../rollup/apply.ts';
import { type CompiledAdjacency, compileAdjacencyQuery } from './adjacency.ts';
import {
  boundsParams,
  type CompilableMetricQuery,
  type CompiledQuery,
  compileMetricQuery,
  metricEmpty,
  queryMeasures,
  unsupported,
} from './compiler.ts';
import { type CompiledLegs, compileDistributionQuery, compileDwellQuery } from './dwell.ts';
import {
  appendGoalStatements,
  attachGoalMetrics,
  type GoalDefinitions,
  goalHourRefusal,
  goalsNeedVisits,
  type PreparedGoal,
  prepareGoals,
} from './goals.ts';
import { planMetricRoute } from './planner.ts';
import { bucketAxis, compareWindow, resolveWindow } from './ranges.ts';
import { compileRollupMetricQuery } from './rollup-compiler.ts';
import { type CompiledSequence, compileSequenceQuery } from './sequences.ts';
import { segmentFilterOf } from './stored.ts';

/**
 * Runs a whole QueryRequest — every widget of a dashboard view — inside one
 * read snapshot, so all results describe the same instant (docs/04 § 3).
 */

/** Requests for a site id that does not exist are a client error, not an empty result. */
export class UnknownSiteError extends Error {}

/**
 * Per-site inclusive local-date windows for a request scope. Presets resolve per
 * site timezone, so these are an input to the answer — the ETag must cover them,
 * and `meta.windows` states them so no client re-derives them (docs/04 § 3).
 */
export function resolveSiteWindows(
  db: Db,
  site: QueryRequest['site'],
  range: Range,
  now: number,
  allowedSites?: readonly number[],
): SiteWindow[] {
  return resolveSites(db, site, allowedSites).map((s) => ({
    siteId: s.id,
    timezone: s.timezone,
    ...resolveWindow(range, s.timezone, now),
  }));
}

export interface ExecuteOptions {
  /** Clock used to resolve range presets — tests pin it. */
  now?: number;
  /**
   * The principal's readable sites (docs/04 § 5). `site: "all"` fans out over
   * this list instead of the directory; absent means unrestricted (admin, or
   * a bare app with no gate). Enforced HERE, inside execution, because the
   * request that crosses to the worker pool carries no principal.
   */
  allowedSites?: readonly number[];
  /**
   * Stored derived-metric definitions by name, resolved on the main thread
   * (query/stored.ts) so the route's ETag can hash them — an edit must expire
   * cached answers, and `dataVersion` never moves for these rows. A `d:` ref
   * with no entry here is answered with an honest per-query error.
   */
  derived?: Readonly<Record<string, string>>;
  /**
   * Stored goal definitions by id — the same treatment as `derived` for the
   * same reasons (query/stored.ts, query/goals.ts). A `goal:` ref with no
   * entry here is answered with an honest per-query error.
   */
  goals?: GoalDefinitions;
}

export function executeQueryRequest(
  db: Db,
  request: QueryRequest,
  options: ExecuteOptions = {},
): QueryResponse {
  const started = performance.now();
  const now = options.now ?? Date.now();
  return withReadSnapshot(db, () => {
    let windows = resolveSiteWindows(db, request.site, request.range, now, options.allowedSites);
    const compare = request.compare;
    const customCompare = typeof compare === 'object' && 'from' in compare;
    if (customCompare) {
      // The label for an index-aligned (possibly unequal-length) comparison:
      // meta.windows states what the compare rows were computed on (docs/04 § 3).
      windows = windows.map((window) => ({
        ...window,
        compareFrom: compare.from,
        compareTo: compare.to,
      }));
    }
    const compareWindows =
      compare === undefined || (typeof compare === 'object' && 'segment' in compare)
        ? undefined
        : windows.map((window) => ({ ...window, ...compareWindow(window, compare) }));
    // Segment-compare re-reads the stored tree inside THIS snapshot; the route
    // already 400ed an unknown id, so an undefined here is only the race with a
    // concurrent delete — the comparison is then omitted, never fabricated.
    const compareFilter =
      typeof compare === 'object' && 'segment' in compare
        ? asFilter(segmentFilterOf(db, compare.segment))
        : undefined;

    // The rollup routing inputs, read once inside the snapshot: whether the
    // session rollups are suspended (stale bounce definition), and the raw
    // floor retention has pruned to (docs/03 § Rollups).
    const sessionRollupsStale = rollupNeedsRebuild(db);
    const horizonTs = rawHorizonTs(db);

    const results: QueryResponse['results'] = {};
    for (const query of request.queries) {
      const queryStarted = performance.now();
      if ('kind' in query) {
        // Session-scoped kinds answer only the primary window: a journey (or a
        // per-page dwell) comparison has no defined shape (docs/04), so
        // `compare` is never fabricated.
        const filters = request.filters ?? [];
        // Every kind walks raw session/event rows; below the retention horizon
        // that walk would return partial numbers, so it refuses instead.
        const pruned = rawHorizonRefusal(windows, horizonTs);
        if (pruned !== undefined) {
          results[query.id] = pruned;
          continue;
        }
        const compiled =
          query.kind === 'dwell'
            ? compileDwellQuery(query, filters, windows)
            : query.kind === 'distribution'
              ? compileDistributionQuery(query, filters, windows)
              : query.kind === 'adjacency'
                ? compileAdjacencyQuery(query, filters, windows)
                : compileSequenceQuery(query, filters, windows);
        if (isQueryError(compiled)) {
          results[query.id] = compiled;
          continue;
        }
        const entry: QueryResult = { rows: runScoped(db, compiled, windows) };
        if ('measures' in compiled) entry.measures = compiled.measures;
        entry.ms = elapsed(queryStarted);
        results[query.id] = entry;
        continue;
      }
      const prepared = prepareMetricQuery(query, options.derived, options.goals, request.site);
      if (isQueryError(prepared)) {
        results[query.id] = prepared;
        continue;
      }
      const hasGoals = prepared.goals.length > 0;
      const hourRefusal = goalHourRefusal(prepared.goals, prepared.query);
      if (hourRefusal !== undefined) {
        results[query.id] = hourRefusal;
        continue;
      }
      // Route per query, planning over EVERY window the compiled statements
      // will run against — a compare window that breaks a rollup rule (a
      // multi-day custom compare under a distinct count) must pull the whole
      // query to raw, or the two row sets would answer different questions.
      // Goal statements aggregate raw event rows, so any goal forces raw.
      const requestFilters = request.filters ?? [];
      const planWindows = compareWindows === undefined ? windows : [...windows, ...compareWindows];
      const route = hasGoals
        ? 'raw'
        : planMetricRoute(prepared.query, requestFilters, planWindows, {
            sessionRollupsStale,
          });
      if (route === 'raw') {
        // Honest refusal at the raw floor (docs/03): this shape NEEDS raw rows,
        // and part of its range no longer has them. Rollup-answerable shapes
        // keep answering below the horizon — that is the point of rollups.
        const pruned = rawHorizonRefusal(planWindows, horizonTs);
        if (pruned !== undefined) {
          results[query.id] = pruned;
          continue;
        }
      }
      // One compile path for the primary rows and the segment-compare rows:
      // base statements, plus one per goal appended for the executor's merge.
      const compileFor = (
        filters: readonly FilterNode[],
        filterRoute: 'rollup' | 'raw',
      ): CompiledQuery | QueryErrorResult => {
        const base =
          filterRoute === 'rollup'
            ? compileRollupMetricQuery(prepared.query, filters, windows)
            : compileMetricQuery(prepared.query, filters, windows, { forceMerge: hasGoals });
        if (isQueryError(base) || !hasGoals) return base;
        return appendGoalStatements(base, prepared.goals, prepared.query, filters, windows);
      };
      const compiled = compileFor(requestFilters, route);
      if (isQueryError(compiled)) {
        results[query.id] = compiled;
        continue;
      }
      const measures = queryMeasures(compiled);
      const refusal = derivedBucketRefusal(prepared, measures);
      if (refusal !== undefined) {
        results[query.id] = refusal;
        continue;
      }
      const entry: QueryResult = { rows: runCompiled(db, compiled, windows) };
      if (compareWindows !== undefined) {
        entry.compare = runCompiled(db, compiled, compareWindows);
      } else if (compareFilter !== undefined) {
        // Segment compare: the SAME query and windows, with the segment's tree
        // AND-ed in beside the request filters — the "what would this look like
        // inside the segment" answer, in the ordinary compare rows slot. Routed
        // on its own: the segment's dimensions may deny the augmented shape the
        // rollup route the bare one took.
        const segmentFilters = [...requestFilters, compareFilter];
        const augmentedRoute = hasGoals
          ? 'raw'
          : planMetricRoute(prepared.query, segmentFilters, windows, {
              sessionRollupsStale,
            });
        const augmentedPruned =
          augmentedRoute === 'raw' ? rawHorizonRefusal(windows, horizonTs) : undefined;
        if (augmentedPruned !== undefined) {
          results[query.id] = augmentedPruned;
          continue;
        }
        const augmented = compileFor(segmentFilters, augmentedRoute);
        if (isQueryError(augmented)) {
          // The requested comparison is unanswerable (the segment's dimensions
          // conflict with the metrics) — refusing the query whole beats rows
          // whose comparison silently vanished.
          results[query.id] = augmented;
          continue;
        }
        entry.compare = runCompiled(db, augmented, windows);
      }
      attachDerived(entry, prepared, measures);
      attachGoalMetrics(entry, prepared.goals, measures);
      entry.measures = measures;
      describeAxis(entry, query, windows, now);
      entry.ms = elapsed(queryStarted);
      results[query.id] = entry;
    }
    return {
      results,
      meta: { generatedInMs: elapsed(started), dataVersion: dataVersion(db), windows },
    };
  });
}

/**
 * States the time axis a bucketed result was computed on, so clients zip their
 * sparse rows against it instead of enumerating buckets themselves (docs/04 § 3).
 *
 * The axis is per site because the window is: `site: "all"` fans out across
 * timezones. It is emitted only when `bucket` is the query's one grouping besides
 * `site` — for `path × day` (deliberately unlimited, so it can be thousands of
 * paths) an axis would invite a dense fill of the whole cross product.
 */
function describeAxis(
  entry: QueryResult,
  query: MetricQuery,
  windows: readonly SiteWindow[],
  now: number,
): void {
  const bucket = query.bucket;
  if (bucket === undefined) return;
  entry.bucket = bucket;
  const dims = [query.dim, query.dim2].filter((dim) => dim !== undefined && dim !== 'site');
  if (dims.length > 0) return;
  const axis = windows.map((window) => bucketAxis(window, bucket, now));
  if (axis.every((site) => site !== undefined)) entry.axis = axis;
}

/** The executor's read of a stored segment: a tree or nothing — the route owns the 400. */
function asFilter(resolved: FilterNode | string): FilterNode | undefined {
  return typeof resolved === 'string' ? undefined : resolved;
}

/**
 * The honest refusal at the raw floor (docs/03 § Rollups): retention records
 * the UTC instant below which raw rows may be gone, and a query that can only
 * be answered from raw rows must refuse a window reaching it — partial numbers
 * are wrong numbers. The comparison is by site-local date because windows are:
 * events dated the horizon's own local date can predate the instant, so that
 * date is already suspect.
 */
export function rawHorizonRefusal(
  windows: readonly SiteWindow[],
  horizonTs: number | undefined,
): QueryErrorResult | undefined {
  if (horizonTs === undefined) return undefined;
  for (const window of windows) {
    if (window.from <= localClock(window.timezone, horizonTs).date) {
      return unsupported(
        'raw events for part of this range have been pruned by retention; ' +
          'this question needs raw rows — narrow the range to more recent dates',
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Derived metrics (docs/04 § 3): resolved to ASTs before compile, evaluated in
// JS after aggregation — identical over primary and compare rows, zero new SQL.
// ---------------------------------------------------------------------------

interface PreparedDerived {
  /** The row/measures column: `d:<name>` exactly as requested. */
  key: string;
  ast: DerivedAst;
  components: readonly Metric[];
}

interface PreparedMetricQuery {
  /** The query as compiled: `d:` refs replaced by their component metrics,
   * `goal:` refs lifted out (their statements compile separately). */
  query: CompilableMetricQuery;
  derived: readonly PreparedDerived[];
  goals: readonly PreparedGoal[];
  bucket: MetricQuery['bucket'];
}

/**
 * Splits a query's metrics into built-ins and derived refs, resolves each ref
 * against the definitions the main thread passed, and folds the expressions'
 * component metrics into the compiled set. Refusals are per query and honest:
 * an unknown name, an unparseable stored expression, or a component set past
 * the per-query ceiling each name exactly what went wrong.
 */
function prepareMetricQuery(
  query: MetricQuery,
  derivedDefs: Readonly<Record<string, string>> | undefined,
  goalDefs: GoalDefinitions | undefined,
  site: QueryRequest['site'],
): PreparedMetricQuery | QueryErrorResult {
  const base: Metric[] = [];
  const derived: PreparedDerived[] = [];
  for (const metric of query.metrics) {
    if (isGoalMetricRef(metric)) continue; // resolved by prepareGoals below
    if (!isDerivedMetricRef(metric)) {
      base.push(metric);
      continue;
    }
    if (derived.some((d) => d.key === metric)) continue;
    const name = derivedNameOf(metric);
    const expr = derivedDefs?.[name];
    if (expr === undefined) return unsupported(`unknown derived metric '${metric}'`);
    let ast: DerivedAst;
    try {
      ast = parseDerivedExpr(expr);
    } catch {
      // Stored rows are client-authored data: an expression that no longer
      // parses fails closed here, never half-evaluates (CLAUDE.md: zod/parse
      // at every boundary, stored JSON included).
      return unsupported(`derived metric '${metric}' is invalid — re-save it`);
    }
    derived.push({ key: metric, ast, components: derivedMetricsOf(ast) });
  }
  const goals = prepareGoals(query.metrics, goalDefs, site);
  if ('error' in goals) return goals;
  const components = [...base, ...derived.flatMap((d) => d.components)];
  // `cr` is conversions/visits: the denominator rides in the rows like a
  // derived metric's components do.
  if (goalsNeedVisits(goals)) components.push('visits');
  const combined = [...new Set(components)];
  if (combined.length > MAX_METRICS_PER_QUERY) {
    return unsupported(
      `this query needs ${combined.length} underlying metrics — the ceiling is ${MAX_METRICS_PER_QUERY}`,
    );
  }
  return { query: { ...query, metrics: combined }, derived, goals, bucket: query.bucket };
}

/**
 * A derived metric over a DISTINCT operand is only honest where the distinct
 * itself is: computed per day (or over the whole undivided window). Any other
 * bucket would ask a client — or this very expression — to recombine distinct
 * counts, which have no total (docs/04 § 3, `measureTotal`).
 */
function derivedBucketRefusal(
  prepared: PreparedMetricQuery,
  measures: Measures,
): QueryErrorResult | undefined {
  const bucket = prepared.bucket;
  if (bucket === undefined || bucket === 'day') return undefined;
  for (const entry of prepared.derived) {
    const distinct = entry.components.find((metric) => measures[metric]?.aggregate === 'distinct');
    if (distinct !== undefined) {
      return unsupported(
        `'${entry.key}' reads the distinct count '${distinct}' — only 'day' buckets (or no bucket) answer it honestly`,
      );
    }
  }
  return undefined;
}

/** Evaluates every derived metric per row — compare rows included — and declares its measure. */
function attachDerived(
  entry: QueryResult,
  prepared: PreparedMetricQuery,
  measures: Measures,
): void {
  for (const item of prepared.derived) {
    for (const row of entry.rows) row[item.key] = evaluateDerived(item.ast, row);
    for (const row of entry.compare ?? []) row[item.key] = evaluateDerived(item.ast, row);
    measures[item.key] = derivedMeasure(item, measures);
  }
}

/**
 * The measure a derived column declares (docs/04 § 3). Exactly `A / B` over two
 * sum-aggregates is a proper `ratio` — the components ride in the same rows, so
 * a client re-aggregates it exactly as it does `views_per_visit`. Every other
 * shape is `computed`: evaluated per row, with no lawful recombination, so no
 * client-side total exists to get wrong.
 */
function derivedMeasure(item: PreparedDerived, measures: Measures): Measure {
  const ast = item.ast;
  if ('op' in ast && ast.op === '/' && 'metric' in ast.left && 'metric' in ast.right) {
    const numerator = measures[ast.left.metric];
    const denominator = measures[ast.right.metric];
    if (numerator?.aggregate === 'sum' && denominator?.aggregate === 'sum') {
      return {
        unit: unitDiv(numerator.unit, denominator.unit),
        population: numerator.population,
        aggregate: 'ratio',
        of: { numerator: ast.left.metric, denominator: ast.right.metric },
      };
    }
  }
  // The parser guarantees ≥1 metric operand; its population stands in for the
  // expression's, which has no single row set of its own.
  const first = item.components[0];
  const population = first === undefined ? 'actions' : (measures[first]?.population ?? 'actions');
  return { unit: 'value', population, aggregate: 'computed' };
}

/** ms per count reads as ms (avg_engagement's shape); anything else is a bare value. */
function unitDiv(numerator: Unit, denominator: Unit): Unit {
  return numerator === 'ms' && denominator === 'count' ? 'ms' : 'value';
}

function resolveSites(
  db: Db,
  scope: QueryRequest['site'],
  allowedSites?: readonly number[],
): Site[] {
  if (scope === 'all') {
    const sites = listSites(db);
    if (allowedSites === undefined) return sites;
    const allowed = new Set(allowedSites);
    return sites.filter((site) => allowed.has(site.id));
  }
  const site = getSite(db, scope);
  // Out of scope answers exactly like nonexistent: a scoped principal must not
  // be able to probe the site directory by the difference (docs/04 § 5).
  if (site === undefined || (allowedSites !== undefined && !allowedSites.includes(scope))) {
    throw new UnknownSiteError(`unknown site id ${scope}`);
  }
  return [site];
}

/** One session-scoped statement (journeys, dwell, adjacency): one SQL text, one window scope. */
function runScoped(
  db: Db,
  compiled: CompiledSequence | CompiledLegs | CompiledAdjacency,
  windows: readonly SiteWindow[],
): ResultRow[] {
  if (windows.length === 0) return [];
  const rows = stmt<ResultRow>(db, compiled.sql).all(
    ...boundsParams(windows),
    ...compiled.params,
  ) as ResultRow[];
  if (compiled.kind === 'flows') {
    // The signature travels as JSON text in SQL; clients get the parsed array.
    for (const row of rows) row.steps = JSON.parse(row.steps as string) as string[];
  }
  return rows;
}

/** Exported for the rollup read-equivalence ratchet, which runs one compiled
 * query per store and diffs the rows; production reaches it via `executeQueryRequest`. */
export function runCompiled(
  db: Db,
  compiled: CompiledQuery,
  windows: readonly SiteWindow[],
): ResultRow[] {
  if (windows.length === 0) return [];
  const bounds = boundsParams(windows);

  const first = compiled.statements[0];
  if (compiled.ordered && first !== undefined) {
    return stmt<ResultRow>(db, first.sql).all(...bounds, ...first.params) as ResultRow[];
  }

  // A query mixing session- and event-shaped metrics ran once per table; join the
  // partial rows on the group key and fill the gaps with each metric's empty value.
  const merged = new Map<string, ResultRow>();
  for (const statement of compiled.statements) {
    const rows = stmt<ResultRow>(db, statement.sql).all(...bounds, ...statement.params);
    for (const raw of rows as ResultRow[]) {
      // JSON per component: SQL NULL must never collide with a literal "null" value.
      const key = compiled.groupKeys
        .map((groupKey) => JSON.stringify(raw[groupKey] ?? null))
        .join('\u0000');
      let row = merged.get(key);
      if (row === undefined) {
        row = {};
        for (const groupKey of compiled.groupKeys) row[groupKey] = raw[groupKey] ?? null;
        for (const metric of compiled.metrics) row[metric] = metricEmpty(metric);
        merged.set(key, row);
      }
      for (const metric of statement.metrics) row[metric] = raw[metric] ?? metricEmpty(metric);
    }
  }
  const rows = sortRows([...merged.values()], compiled);
  return compiled.limit === undefined ? rows : rows.slice(0, compiled.limit);
}

/** Mirrors the SQL ordering of single-statement queries (compiler.orderClause). */
function sortRows(rows: ResultRow[], compiled: CompiledQuery): ResultRow[] {
  const metric = compiled.metrics[0];
  const dimKey = compiled.groupKeys[0];
  if (metric === undefined || dimKey === undefined) return rows;
  rows.sort((a, b) => {
    if (compiled.hasBucket) {
      const byBucket = compareValues(a.bucket, b.bucket);
      if (byBucket !== 0 || compiled.groupKeys.length === 1) return byBucket;
      return compareMetric(a[metric], b[metric]);
    }
    const byMetric = compareMetric(a[metric], b[metric]);
    return byMetric !== 0 ? byMetric : compareValues(a[dimKey], b[dimKey]);
  });
  return rows;
}

/** Descending, nulls last. */
function compareMetric(a: unknown, b: unknown): number {
  const left = typeof a === 'number' ? a : null;
  const right = typeof b === 'number' ? b : null;
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  // SQLite sorts NULL first in ASC order; the JS path must agree with the SQL path.
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10;
}
