import {
  type FilterNode,
  type GoalAspect,
  GoalFiltersSchema,
  type GoalValueExpr,
  goalRefParts,
  isGoalMetricRef,
  type Measures,
  parseGoalValueExpr,
  type QueryErrorResult,
  type QueryRequest,
  type QueryResult,
  type ResultRow,
  type SiteWindow,
} from '@featherstat/shared';
import {
  type CompilableMetricQuery,
  type CompiledQuery,
  type CompileError,
  compileGoalStatement,
  compileSiteVisits,
  unsupported,
} from './compiler.ts';

/**
 * Goal metrics in the executor (docs/04 § 3). Definitions resolve on the MAIN
 * thread (query/stored.ts) and ship across the pool as verbatim stored columns,
 * exactly as derived metrics do — the route's ETag hashes them, so a goal edit
 * expires every cached answer. Here they are re-parsed (fail closed: stored
 * rows are client-authored data), compiled into one extra events-table
 * statement per goal through the ordinary filter compiler (invariant 9), and
 * merged with the query's own statements on the group keys.
 *
 * Semantics, stated where they are implemented:
 *
 * - A conversion is a SESSION with ≥1 non-ping event matching the goal's
 *   filters — `COUNT(DISTINCT session_id)`.
 * - A conversion's bucket is the completing EVENT's local date. docs/04 § 3
 *   names this deliberate simplification: the plan's "session's local_date"
 *   would need a join per goal, and the day the completing event happened is
 *   the honest reading of "when did this convert".
 * - Hour shapes refuse: distinct sessions per hour do not sum to the day
 *   (a session spans hours as a matter of course), so an hour bucket — or the
 *   `local_hour` dimension — would manufacture recombinable-looking numbers.
 * - A goal belongs to one site. Under `site: "all"` its `cr` divides by that
 *   site's visits alone (its own `goal:<id>:visits` column, not the query's
 *   `visits` over every site), and a row grouped by another site reads null
 *   for every aspect: the goal does not exist there.
 */

/** The definition shape shipped across the pool protocol, keyed by decimal id.
 * Verbatim stored columns — JSON-safe, hashable, parsed only in the executor. */
interface GoalDefinition {
  siteId: number;
  /** The `goals.filters` column: a JSON array of FilterNode. */
  filters: string;
  /** The `goals.value_expr` column: 'event_value' | 'fixed:<n>' | null. */
  valueExpr: string | null;
}

export type GoalDefinitions = Readonly<Record<string, GoalDefinition>>;

export interface PreparedGoal {
  id: number;
  siteId: number;
  filters: FilterNode[];
  valueExpr: GoalValueExpr;
  aspects: ReadonlySet<GoalAspect>;
  /** The column `cr` divides by: the query's `visits` when the request is
   * scoped to the goal's site, else the goal's own site-restricted visits. */
  denominator: string;
}

function keyOf(id: number, aspect: GoalAspect): string {
  return `goal:${id}:${aspect}`;
}

const SCOPE_VISITS = 'visits';

/**
 * Splits a query's `goal:` refs from its other metrics and resolves each
 * against the shipped definitions. Refusals are per query and honest: an
 * unknown id, a goal of a site outside the request's scope, and an
 * unparseable stored row each name exactly what went wrong.
 */
export function prepareGoals(
  metrics: readonly string[],
  definitions: GoalDefinitions | undefined,
  site: QueryRequest['site'],
): PreparedGoal[] | QueryErrorResult {
  const goals = new Map<number, PreparedGoal>();
  for (const metric of metrics) {
    if (!isGoalMetricRef(metric)) continue;
    const { id, aspect } = goalRefParts(metric);
    const existing = goals.get(id);
    if (existing !== undefined) {
      (existing.aspects as Set<GoalAspect>).add(aspect);
      continue;
    }
    const def = definitions?.[String(id)];
    if (def === undefined) return unsupported(`unknown goal ${id}`);
    if (site !== 'all' && def.siteId !== site) {
      return unsupported(`goal ${id} belongs to another site than this query's scope`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(def.filters);
    } catch {
      raw = undefined;
    }
    const parsed = GoalFiltersSchema.safeParse(raw);
    if (!parsed.success) return unsupported(`goal ${id} is invalid — re-save it`);
    goals.set(id, {
      id,
      siteId: def.siteId,
      filters: parsed.data,
      valueExpr: parseGoalValueExpr(def.valueExpr),
      aspects: new Set([aspect]),
      denominator: site === 'all' ? `goal:${id}:visits` : SCOPE_VISITS,
    });
  }
  return [...goals.values()];
}

/** True when a goal's `cr` divides by the query's own `visits` — the executor
 * then folds it in, exactly as a derived metric folds its components in. */
export function goalsNeedVisits(goals: readonly PreparedGoal[]): boolean {
  return goals.some((goal) => goal.aspects.has('cr') && goal.denominator === SCOPE_VISITS);
}

/**
 * The hour-honesty refusal: per-bucket distinct sessions only compose above
 * the hour grain (docs/04 § 3). Checked before compilation so the message
 * names the rule, not a wiring failure.
 */
export function goalHourRefusal(
  goals: readonly PreparedGoal[],
  query: Pick<CompilableMetricQuery, 'dim' | 'dim2' | 'bucket'>,
): QueryErrorResult | undefined {
  if (goals.length === 0) return undefined;
  if (query.bucket === 'hour' || query.dim === 'local_hour' || query.dim2 === 'local_hour') {
    return unsupported(
      'goal metrics count distinct sessions, which span hours — ' +
        "only 'day' and coarser buckets answer them honestly",
    );
  }
  return undefined;
}

/**
 * The base compilation plus one statement per goal, merged by the executor's
 * ordinary multi-statement path. The base must have been compiled with
 * `forceMerge` — a pre-limited base statement would clip groups the merge
 * still needs.
 */
export function appendGoalStatements(
  compiled: CompiledQuery,
  goals: readonly PreparedGoal[],
  query: Pick<CompilableMetricQuery, 'dim' | 'dim2' | 'bucket' | 'filters'>,
  requestFilters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledQuery | CompileError {
  const statements = [...compiled.statements];
  const metrics = [...compiled.metrics];
  for (const goal of goals) {
    if (goal.aspects.has('cr') && goal.denominator !== SCOPE_VISITS) {
      const visits = compileSiteVisits(
        goal.denominator,
        goal.siteId,
        query,
        requestFilters,
        windows,
      );
      if ('error' in visits) return visits;
      statements.push(visits);
      metrics.push(...visits.metrics);
    }
    const statement = compileGoalStatement(
      {
        conversionsKey: keyOf(goal.id, 'conversions'),
        ...(goal.valueExpr === 'event_value' ? { valueKey: keyOf(goal.id, 'value') } : {}),
        siteId: goal.siteId,
        filters: goal.filters,
      },
      query,
      requestFilters,
      windows,
    );
    if ('error' in statement) return statement;
    statements.push(statement);
    metrics.push(...statement.metrics);
  }
  return { ...compiled, statements, metrics, ordered: false };
}

/**
 * Post-aggregation aspects and the measures header (docs/04 § 3). `cr` is a
 * proper ratio over columns riding the same rows; a fixed-value `value` is
 * fixed × conversions — a scalar over a distinct count, so `computed`, with
 * no client-side total to get wrong.
 */
export function attachGoalMetrics(
  entry: QueryResult,
  goals: readonly PreparedGoal[],
  measures: Measures,
): void {
  for (const goal of goals) {
    const conversionsKey = keyOf(goal.id, 'conversions');
    measures[conversionsKey] = { unit: 'count', population: 'actions', aggregate: 'distinct' };
    if (goal.aspects.has('cr')) {
      const crKey = keyOf(goal.id, 'cr');
      const denominator = goal.denominator;
      applyRows(entry, (row) => {
        row[crKey] = crOf(row[conversionsKey], row[denominator]);
      });
      measures[crKey] = {
        unit: 'rate',
        population: 'sessions',
        aggregate: 'ratio',
        of: { numerator: conversionsKey, denominator },
      };
    }
    if (goal.aspects.has('value')) {
      const valueKey = keyOf(goal.id, 'value');
      if (goal.valueExpr === 'event_value') {
        // Already computed in SQL as SUM(event_value) over the matching rows.
        measures[valueKey] = { unit: 'value', population: 'events', aggregate: 'sum' };
      } else {
        const fixed = goal.valueExpr === null ? null : goal.valueExpr.fixed;
        applyRows(entry, (row) => {
          const conversions = row[conversionsKey];
          row[valueKey] =
            fixed === null || typeof conversions !== 'number' ? null : fixed * conversions;
        });
        measures[valueKey] = { unit: 'value', population: 'actions', aggregate: 'computed' };
      }
    }
    const aspectKeys = [...goal.aspects].map((aspect) => keyOf(goal.id, aspect));
    applyRows(entry, (row) => {
      if (row.site === undefined || row.site === goal.siteId) return;
      for (const key of [conversionsKey, ...aspectKeys]) row[key] = null;
    });
  }
}

function applyRows(entry: QueryResult, apply: (row: ResultRow) => void): void {
  for (const row of entry.rows) apply(row);
  for (const row of entry.compare ?? []) apply(row);
}

/** Unknown when there are no visits to convert — 0/0 is not a rate. */
function crOf(conversions: unknown, visits: unknown): number | null {
  if (typeof conversions !== 'number' || typeof visits !== 'number' || visits === 0) return null;
  return conversions / visits;
}
