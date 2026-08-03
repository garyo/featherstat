import {
  type ChangesDimension,
  type ChangesQuery,
  type Compare,
  type FilterNode,
  isQueryError,
  type QueryErrorResult,
  type QueryResult,
  type ResultRow,
  type SiteWindow,
} from '@featherstat/shared';
import {
  type CompilableMetricQuery,
  type CompiledQuery,
  compileMetricQuery,
  measureOf,
  preferredTable,
  unsupported,
} from './compiler.ts';
import { planMetricRoute } from './planner.ts';
import { compileRollupMetricQuery } from './rollup-compiler.ts';

/**
 * The `changes` kind (docs/04 § 3): what moved between the current window and
 * its compare window, and by how much. Per dimension it runs the ordinary
 * grouped metric query — compiled by `compileMetricQuery` and routed through
 * the planner, so rollup speed applies — over BOTH windows with no limit,
 * outer-joins the two row sets in JS on the dimension value, and keeps the top
 * `limit` movers by |delta|.
 *
 * Server-side because the union of keys is the whole point: contribution
 * ranking must see a page that fell out of the current period's top N — its
 * delta is exactly the story — and a client composing two top-N lists cannot.
 */

export interface ChangesContext {
  filters: readonly FilterNode[];
  windows: readonly SiteWindow[];
  /** Undefined when the request had no compare, or a `{segment}` one. */
  compareWindows: readonly SiteWindow[] | undefined;
  compare: Compare | undefined;
  sessionRollupsStale: boolean;
  /** The executor's `runCompiled`, bound to its snapshot connection. */
  run(compiled: CompiledQuery, windows: readonly SiteWindow[]): ResultRow[];
  /** The executor's raw-horizon refusal, bound to the snapshot's horizon. */
  horizonRefusal(windows: readonly SiteWindow[]): QueryErrorResult | undefined;
}

export function runChangesQuery(
  query: ChangesQuery,
  context: ChangesContext,
): QueryResult | QueryErrorResult {
  if (context.compare === undefined) {
    return unsupported(
      "changes needs a compare period — set compare to 'previous', 'year' or an explicit {from, to} window",
    );
  }
  if (context.compareWindows === undefined) {
    return unsupported(
      'changes compares two time windows — a {segment} compare has no second window; ' +
        "use a time compare and put the segment in 'filters'",
    );
  }

  const rows: ResultRow[] = [];
  // Both windows feed the routing decision, exactly as the executor plans
  // metric queries: a compare window that breaks a rollup rule must pull the
  // whole sub-query to raw, or the two row sets would answer different questions.
  const planWindows = [...context.windows, ...context.compareWindows];
  for (const dim of new Set(query.dims)) {
    // The grouped sub-query: metric × dim, request filters applied, NO limit —
    // the join below needs every key both windows produced.
    const sub: CompilableMetricQuery = {
      id: `${query.id}:${dim}`,
      metrics: [query.metric],
      dim,
    };
    const route = planMetricRoute(sub, context.filters, planWindows, {
      sessionRollupsStale: context.sessionRollupsStale,
    });
    if (route === 'raw') {
      const pruned = context.horizonRefusal(planWindows);
      if (pruned !== undefined) return pruned;
    }
    const compiled =
      route === 'rollup'
        ? compileRollupMetricQuery(sub, context.filters, context.windows)
        : compileMetricQuery(sub, context.filters, context.windows);
    if (isQueryError(compiled)) return compiled;
    rows.push(
      ...moverRows(
        dim,
        query,
        context.run(compiled, context.windows),
        context.run(compiled, context.compareWindows),
      ),
    );
  }

  // The metric's measure, from its preferred table — what makes `visitors`
  // wear `distinct` so clients mark its columns `~`: each window's number is a
  // per-window distinct, so the delta is a difference of two approximations
  // (docs/04 § 3). `share` is per-row arithmetic with no lawful recombination.
  const measure = measureOf(query.metric, preferredTable(query.metric));
  return {
    rows,
    measures: {
      current: measure,
      previous: measure,
      delta: measure,
      share: { unit: 'rate', population: measure.population, aggregate: 'computed' },
    },
  };
}

interface Mover {
  value: string | number | null;
  current: number;
  previous: number;
}

/**
 * Full outer join on the dimension value, then the top `limit` by |delta| —
 * ties broken by higher current, then by value for determinism. `share` is the
 * row's delta over the dimension's WHOLE net change (Σcur − Σprev before the
 * limit), so the kept rows' shares state how much of the move they explain;
 * null when the totals net to zero (shares of nothing are not numbers).
 */
function moverRows(
  dim: ChangesDimension,
  query: ChangesQuery,
  current: readonly ResultRow[],
  previous: readonly ResultRow[],
): ResultRow[] {
  const joined = new Map<string, Mover>();
  const entryOf = (row: ResultRow): Mover => {
    const raw = row[dim] ?? null;
    const value = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
    // JSON keys so SQL NULL can never collide with a literal "null" value.
    const key = JSON.stringify(value);
    let entry = joined.get(key);
    if (entry === undefined) {
      entry = { value, current: 0, previous: 0 };
      joined.set(key, entry);
    }
    return entry;
  };
  for (const row of current) entryOf(row).current = numberOf(row[query.metric]);
  for (const row of previous) entryOf(row).previous = numberOf(row[query.metric]);

  let totalDelta = 0;
  for (const entry of joined.values()) totalDelta += entry.current - entry.previous;

  const movers = [...joined.values()].sort((a, b) => {
    const byDelta = Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous);
    if (byDelta !== 0) return byDelta;
    if (a.current !== b.current) return b.current - a.current;
    return compareValues(a.value, b.value);
  });
  return movers.slice(0, query.limit).map((entry) => {
    const delta = entry.current - entry.previous;
    return {
      dim,
      value: entry.value,
      current: entry.current,
      previous: entry.previous,
      delta,
      share: totalDelta === 0 ? null : delta / totalDelta,
    };
  });
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** NULL first, matching the SQL collation the sub-queries sort with. */
function compareValues(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The natural-language summary — ONE implementation, shared by the weekly
// digest job and the MCP `what_changed` tool so the two can never phrase the
// same movement differently.
// ---------------------------------------------------------------------------

/** A net move below this many percent reads as steady. */
const QUIET_PCT = 3;

export interface ChangesMover {
  /** The dimension the row was grouped by — it decides how a NULL value reads. */
  dim: string;
  value: string | number | null;
  delta: number;
}

/** The `changes` rows as movers, for either caller of the summary. */
export function moversOf(rows: readonly Record<string, unknown>[]): ChangesMover[] {
  return rows.flatMap((row) => {
    const delta = row.delta;
    if (typeof delta !== 'number') return [];
    const value = row.value;
    return [
      {
        dim: typeof row.dim === 'string' ? row.dim : '',
        value: typeof value === 'string' || typeof value === 'number' ? value : null,
        delta,
      },
    ];
  });
}

/**
 * What a NULL group is CALLED in prose, per dimension. A dimension absent here
 * is never named as a driver: `path` is absent because "no path drove it" is
 * not a sentence a reader can act on, and the row is still in the result — this
 * is the wording of the summary, not the query's semantics.
 */
const NULL_NAME: Readonly<Record<string, string>> = {
  ref_domain: 'direct traffic',
  utm_campaign: 'untagged traffic',
  country: 'unknown location',
} satisfies Partial<Record<ChangesDimension, string>>;

/**
 * One sentence: "example.org: visits up 18% (1.2k → 1.4k) — /blog/foo (+212)
 * and news.ycombinator.com (+180) drove it". Falling is symmetrical; a quiet
 * site reads "example.org: steady (±2%)". Movers are the `changes` rows —
 * only those pushing in the net direction are cited as drivers.
 */
export function summarizeChanges(
  label: string,
  metric: string,
  current: number,
  previous: number,
  movers: readonly ChangesMover[],
): string {
  const delta = current - previous;
  const pct = previous > 0 ? (delta / previous) * 100 : current > 0 ? 100 : 0;
  if (Math.abs(pct) < QUIET_PCT) {
    return `${label}: steady (±${Math.abs(pct).toFixed(0)}%)`;
  }
  const head =
    `${label}: ${metric} ${delta > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% ` +
    `(${compact(previous)} → ${compact(current)})`;
  const drivers = driversOf(movers, Math.sign(delta));
  if (drivers.length === 0) return head;
  return `${head} — ${drivers.join(' and ')} ${delta > 0 ? 'drove it' : 'drove the drop'}`;
}

interface Driver {
  dim: string;
  name: string;
  delta: number;
}

/**
 * At most two named drivers, biggest first: only movers pushing the net way,
 * only those a NULL value has a name for, and — because two rows of one
 * dimension are usually one story told twice — the second is taken from a
 * DIFFERENT dimension when one is available, falling back to same-dim.
 */
function driversOf(movers: readonly ChangesMover[], direction: number): string[] {
  const named = movers
    .filter((mover) => Math.sign(mover.delta) === direction)
    .flatMap((mover): Driver[] => {
      const name = mover.value === null ? NULL_NAME[mover.dim] : String(mover.value);
      return name === undefined ? [] : [{ dim: mover.dim, name, delta: mover.delta }];
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const first = named[0];
  if (first === undefined) return [];
  const rest = named.slice(1).filter((driver) => driver.name !== first.name);
  const second = rest.find((driver) => driver.dim !== first.dim) ?? rest[0];
  return (second === undefined ? [first] : [first, second]).map(
    (driver) => `${driver.name} (${signed(driver.delta)})`,
  );
}

function signed(delta: number): string {
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/** 1234 → '1.2k': the digest is a glance, not a report. */
function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}m`;
  if (abs >= 1_000) return `${trim((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

function trim(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
