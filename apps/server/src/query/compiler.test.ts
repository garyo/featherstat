import {
  type Aggregate,
  BaseDimensionSchema,
  DimensionSchema,
  ENGAGEMENT_THRESHOLD_MS,
  EVENT_ONLY_DIMENSIONS,
  EVENT_ONLY_METRICS,
  isQueryError,
  type Metric,
  MetricSchema,
  POPULATIONS,
  type Population,
  SESSION_ONLY_DIMENSIONS,
  SESSION_ONLY_METRICS,
  type SiteWindow,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  type CompilableMetricQuery,
  type CompiledQuery,
  compileMetricQuery,
  measureOf,
  metricTables,
  queryMeasures,
  type Table,
} from './compiler.ts';

const TABLES = ['events', 'sessions'] as const satisfies readonly Table[];

/** One window per site over whole local dates — what every date-granular preset resolves to. */
const sites = (count: number): SiteWindow[] =>
  Array.from({ length: count }, (_, index) => ({
    siteId: index + 1,
    timezone: 'UTC',
    from: '2026-07-01',
    to: '2026-07-31',
  }));

function compile(
  query: Partial<CompilableMetricQuery> & Pick<CompilableMetricQuery, 'metrics'>,
): CompiledQuery {
  const compiled = compileMetricQuery({ id: 'q', ...query }, [], sites(1));
  if (isQueryError(compiled)) {
    throw new Error(`unexpected compile error: ${compiled.error.message}`);
  }
  return compiled;
}

describe('shared vocabulary constants stay true to the compiler tables', () => {
  it('EVENT_ONLY_DIMENSIONS = exactly the dims that break session metrics', () => {
    const eventOnly = new Set<string>(EVENT_ONLY_DIMENSIONS);
    for (const dim of BaseDimensionSchema.options) {
      const compiled = compileMetricQuery({ id: 'q', metrics: ['engaged_ms'], dim }, [], sites(1));
      expect(isQueryError(compiled), dim).toBe(eventOnly.has(dim));
    }
  });

  it('SESSION_ONLY_METRICS = exactly the metrics an event-level dim cannot answer', () => {
    const sessionOnly = new Set<string>(SESSION_ONLY_METRICS);
    for (const metric of MetricSchema.options) {
      const compiled = compileMetricQuery(
        { id: 'q', metrics: [metric], dim: 'path' },
        [],
        sites(1),
      );
      expect(isQueryError(compiled), metric).toBe(sessionOnly.has(metric));
    }
  });

  it('SESSION_ONLY_DIMENSIONS = exactly the dims that break event-level metrics', () => {
    const sessionOnly = new Set<string>(SESSION_ONLY_DIMENSIONS);
    for (const dim of BaseDimensionSchema.options) {
      const compiled = compileMetricQuery({ id: 'q', metrics: ['pageviews'], dim }, [], sites(1));
      expect(isQueryError(compiled), dim).toBe(sessionOnly.has(dim));
    }
  });

  it('EVENT_ONLY_METRICS = exactly the metrics a session-only dim cannot answer', () => {
    const eventOnly = new Set<string>(EVENT_ONLY_METRICS);
    for (const metric of MetricSchema.options) {
      const compiled = compileMetricQuery(
        { id: 'q', metrics: [metric], dim: 'entry_path' },
        [],
        sites(1),
      );
      expect(isQueryError(compiled), metric).toBe(eventOnly.has(metric));
    }
  });
});

/**
 * The vocabulary itself, ranged over rather than spot-checked — the shape of the
 * dimension test above, applied to what a metric COUNTS.
 *
 * Every metric declares a population and an aggregate; nothing hand-writes a row
 * predicate. That is the whole point of P2: `visitors` and `visits` disagreeing
 * about heartbeats was invisible because no test ever ranged over the metric
 * table, only over hand-picked pairs.
 */
describe('every metric declares what it counts', () => {
  /** The declared population and aggregate of each metric, per table it answers. */
  const EXPECTED: Record<Metric, Partial<Record<Table, [Population, Aggregate]>>> = {
    visitors: { events: ['actions', 'distinct'] },
    // Two tables, two aggregates — the routing decides, and the header says so.
    visits: { sessions: ['sessions', 'sum'], events: ['actions', 'distinct'] },
    pageviews: { events: ['pageviews', 'sum'] },
    events: { events: ['events', 'sum'] },
    outlinks: { events: ['outlinks', 'sum'] },
    downloads: { events: ['downloads', 'sum'] },
    event_value_sum: { events: ['events', 'sum'] },
    engaged_ms: { sessions: ['sessions', 'sum'] },
    engaged_sessions: { sessions: ['measured_sessions', 'sum'] },
    avg_engagement: { sessions: ['measured_sessions', 'ratio'] },
    bounce_rate: { sessions: ['sessions', 'ratio'] },
    views_per_visit: { sessions: ['sessions', 'ratio'] },
  };

  it('declares a population and an aggregate for every table it answers from', () => {
    for (const metric of MetricSchema.options) {
      const expected = EXPECTED[metric];
      for (const table of TABLES) {
        const answers = metricTables(metric).includes(table);
        expect(answers, `${metric} over ${table}`).toBe(expected[table] !== undefined);
        if (!answers) continue;
        const measure = measureOf(metric, table);
        expect([measure.population, measure.aggregate], `${metric} over ${table}`).toEqual(
          expected[table],
        );
      }
    }
  });

  it('gives every ratio the denominator its re-aggregation needs, and nothing else one', () => {
    for (const metric of MetricSchema.options) {
      for (const table of metricTables(metric)) {
        const measure = measureOf(metric, table);
        if (measure.aggregate !== 'ratio') {
          expect(measure.of, `${metric} is not a ratio`).toBeUndefined();
          continue;
        }
        const of = measure.of;
        if (of === undefined) throw new Error(`${metric}: a ratio must declare its components`);
        // Both names must be metrics of the same vocabulary, or a client cannot
        // find the column to re-weight on.
        expect(MetricSchema.options, `${metric} denominator`).toContain(of.denominator);
        if (of.numerator !== undefined) {
          expect(MetricSchema.options, `${metric} numerator`).toContain(of.numerator);
        }
      }
    }
  });

  it('composes the population as a CASE, never a WHERE — one SELECT, mixed populations', () => {
    // `visitors` counts non-ping rows and `pageviews` counts pageview rows, in
    // the SAME statement. A population that filtered rows could serve only one
    // of them; the CASE wrapper is what keeps the batch one statement per table.
    const compiled = compile({ metrics: ['visitors', 'pageviews', 'events'] });
    expect(compiled.statements).toHaveLength(1);
    const sql = compiled.statements[0]?.sql ?? '';
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN e.type != 'ping' THEN e.visitor_id END)");
    expect(sql).toContain("SUM(CASE WHEN e.type = 'pageview' THEN 1 ELSE 0 END)");
    expect(sql).toContain("SUM(CASE WHEN e.type = 'event' THEN 1 ELSE 0 END)");
    // No population reached the WHERE clause: the only WHERE a query has comes
    // from its filters, and this one has none.
    expect(sql).not.toContain('WHERE');
  });

  it('reports the measures of a query as its statements were actually routed', () => {
    const plain = queryMeasures(compile({ metrics: ['visits'] }));
    expect(plain.visits).toEqual({ unit: 'count', population: 'sessions', aggregate: 'sum' });

    // The same metric, forced onto the events table by an event-level dimension.
    const byPath = queryMeasures(compile({ metrics: ['visits'], dim: 'path' }));
    expect(byPath.visits).toEqual({ unit: 'count', population: 'actions', aggregate: 'distinct' });

    // A mixed query is two statements; the header still covers every metric.
    const mixed = queryMeasures(compile({ metrics: ['visitors', 'engaged_ms', 'bounce_rate'] }));
    expect(Object.keys(mixed).sort()).toEqual(['bounce_rate', 'engaged_ms', 'visitors']);
    expect(mixed.bounce_rate?.unit).toBe('rate');
  });

  it('keeps `presence` out of the metric vocabulary, where realtime alone counts it', () => {
    // Realtime's "active now" counts presence (realtime/hub.ts) and no metric
    // does — the deliberate difference P2 exists to make visible. It stays a
    // named population so the difference reads as intent, not as an oversight.
    for (const metric of MetricSchema.options) {
      for (const table of metricTables(metric)) {
        expect(measureOf(metric, table).population, metric).not.toBe('presence');
      }
    }
  });

  it('declares a population whose rows live in the table that answers it', () => {
    for (const metric of MetricSchema.options) {
      for (const table of metricTables(metric)) {
        const spec = POPULATIONS[measureOf(metric, table).population];
        expect(spec.rows, `${metric} over ${table}`).toBe(table === 'events' ? 'hits' : 'visits');
        if (spec.rows === 'visits') expect(spec.hitTypes, metric).toBeNull();
      }
    }
  });
});

describe('compileMetricQuery', () => {
  it('routes each metric to its preferred table', () => {
    const events = compile({ metrics: ['pageviews', 'visitors', 'events', 'event_value_sum'] });
    expect(events.statements.map((s) => s.table)).toEqual(['events']);

    const sessions = compile({ metrics: ['visits', 'engaged_ms', 'views_per_visit'] });
    expect(sessions.statements.map((s) => s.table)).toEqual(['sessions']);

    // An event-level dimension makes sessions unusable; visits falls back to events.
    const fallback = compile({ metrics: ['visits'], dim: 'path' });
    expect(fallback.statements.map((s) => s.table)).toEqual(['events']);
  });

  it('splits a mixed-shape query into one statement per table', () => {
    const mixed = compile({ metrics: ['visitors', 'pageviews', 'engaged_ms', 'bounce_rate'] });
    expect(mixed.statements.map((s) => s.table).sort()).toEqual(['events', 'sessions']);
    expect(mixed.ordered).toBe(false);
  });

  it('binds the engagement threshold — never inlines it', () => {
    const compiled = compile({ metrics: ['bounce_rate'] });
    const statement = compiled.statements[0];
    expect(statement?.sql).not.toContain(String(ENGAGEMENT_THRESHOLD_MS));
    expect(statement?.params).toContain(ENGAGEMENT_THRESHOLD_MS);
    expect(statement?.sql).toContain('s.pageviews = 1 AND s.events = 0 AND s.engaged_ms < ?');
  });

  it('never interpolates filter values into the SQL text', () => {
    const hostile = "'; DROP TABLE events; --";
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['pageviews'], filters: [{ dim: 'path', op: 'eq', value: hostile }] },
      [],
      sites(1),
    );
    if (isQueryError(compiled)) throw new Error('expected success');
    expect(compiled.statements[0]?.sql).not.toContain('DROP');
    expect(compiled.statements[0]?.params).toEqual([hostile]);
  });

  it('compiles every filter op with bound parameters', () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [
        { dim: 'country', op: 'in', value: ['US', 'DE'] },
        { dim: 'path', op: 'contains', value: '50%_off' },
        { dim: 'path', op: 'starts', value: '/docs' },
        { dim: 'country', op: 'neq', value: 'FR' },
      ],
    });
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('e.country IN (?, ?)');
    expect(statement?.sql).toContain("e.path LIKE ? ESCAPE '\\'");
    expect(statement?.sql).toContain('e.country IS NOT ?');
    expect(statement?.params).toEqual(['US', 'DE', '%50\\%\\_off%', '/docs%', 'FR']);
  });

  it('binds digit strings as numbers for numeric dimensions', () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'weekday', op: 'eq', value: '1' }],
    });
    expect(compiled.statements[0]?.params).toEqual([1]);
  });

  it("compiles 'is_null' to IS NULL with nothing bound", () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'ref_domain', op: 'is_null' }],
    });
    expect(compiled.statements[0]?.sql).toContain('WHERE e.ref_domain IS NULL');
    expect(compiled.statements[0]?.params).toEqual([]);
  });

  it('rejects session metrics crossed with event-level dimensions', () => {
    const byDim = compileMetricQuery(
      { id: 'q', metrics: ['bounce_rate'], dim: 'title' },
      [],
      sites(1),
    );
    expect(byDim).toHaveProperty(['error', 'code'], 'unsupported');

    const byFilter = compileMetricQuery(
      { id: 'q', metrics: ['engaged_ms'], filters: [{ dim: 'path', op: 'eq', value: '/' }] },
      [],
      sites(1),
    );
    expect(byFilter).toHaveProperty(['error', 'code'], 'unsupported');

    const byBucket = compileMetricQuery(
      { id: 'q', metrics: ['engaged_ms'], bucket: 'hour' },
      [],
      sites(1),
    );
    expect(byBucket).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('rejects a list value for single-value ops', () => {
    const compiled = compileMetricQuery(
      {
        id: 'q',
        metrics: ['pageviews'],
        filters: [{ dim: 'path', op: 'eq', value: ['/a', '/b'] }],
      },
      [],
      sites(1),
    );
    expect(compiled).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('emits one bounds tuple per site and a bound LIMIT', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['pageviews'], dim: 'path', limit: 5 },
      [],
      sites(3),
    );
    if (isQueryError(compiled)) throw new Error('expected success');
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)');
    expect(statement?.sql).toContain('ORDER BY "pageviews" DESC, 1');
    expect(statement?.sql).toContain('LIMIT ?');
    expect(statement?.params).toEqual([5]);
  });

  it('compiles any/not trees to parenthesized, fully parameterized SQL', () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [
        {
          any: [
            { dim: 'country', op: 'eq', value: 'US' },
            { not: { dim: 'path', op: 'starts', value: '/docs' } },
          ],
        },
      ],
    });
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain(
      "(e.country = ? OR NOT COALESCE((e.path LIKE ? ESCAPE '\\'), 0))",
    );
    expect(statement?.params).toEqual(['US', '/docs%']);
  });

  it('never interpolates a filter value from any nested position', () => {
    const hostile = "'; DROP TABLE events; --";
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [
        {
          any: [
            { not: { dim: 'path', op: 'glob', value: hostile } },
            { all: [{ dim: 'title', op: 'contains', value: hostile }] },
          ],
        },
      ],
    });
    const statement = compiled.statements[0];
    expect(statement?.sql).not.toContain('DROP');
    expect(statement?.params).toEqual([hostile, `%${hostile}%`]);
  });

  it("compiles 'glob' to a bound GLOB, the pattern never in the SQL text", () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'path', op: 'glob', value: '/docs/*' }],
    });
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('WHERE e.path GLOB ?');
    expect(statement?.sql).not.toContain('/docs/*');
    expect(statement?.params).toEqual(['/docs/*']);
  });

  it("negation is NULL-safe: `not` compiles through COALESCE, matching leaf 'neq'", () => {
    // A row whose dimension is NULL evaluates `eq` to SQL NULL; a bare NOT would
    // drop it from BOTH the filter and its negation. COALESCE pins it to false
    // first, so not(eq) admits the NULL row exactly as `neq` (IS NOT) does.
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [{ not: { dim: 'ref_domain', op: 'eq', value: 'google.com' } }],
    });
    expect(compiled.statements[0]?.sql).toContain('NOT COALESCE((e.ref_domain = ?), 0)');
  });

  it("scope:'session' compiles as EXISTS over the session's non-ping events", () => {
    const compiled = compile({
      metrics: ['visits', 'bounce_rate'],
      filters: [{ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' }],
    });
    expect(compiled.statements.map((s) => s.table)).toEqual(['sessions']);
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain(
      "EXISTS (SELECT 1 FROM events e2 WHERE e2.session_id = s.id AND e2.type != 'ping' AND e2.path = ?)",
    );
    expect(statement?.params).toContain('/pricing');
  });

  it("scope:'session' on the events table semi-joins through the same bounds CTE", () => {
    const compiled = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'path', op: 'eq', value: '/pricing', scope: 'session' }],
    });
    const sql = compiled.statements[0]?.sql ?? '';
    expect(sql).toContain('e.session_id IN (SELECT e2.session_id');
    // The subquery walks the window, never all history: it rides the bounds CTE.
    expect(sql).toContain(
      'events e2 JOIN bounds ON e2.site_id = bounds.site_id\n  AND e2.local_date BETWEEN bounds.from_date AND bounds.to_date',
    );
    expect(sql).toContain("WHERE e2.type != 'ping' AND e2.path = ?");
  });

  it('a session-scoped event-only dim never blocks session metrics; hit scope still does', () => {
    const scoped = compileMetricQuery(
      {
        id: 'q',
        metrics: ['engaged_ms'],
        filters: [{ dim: 'path', op: 'eq', value: '/', scope: 'session' }],
      },
      [],
      sites(1),
    );
    expect(isQueryError(scoped)).toBe(false);

    const hit = compileMetricQuery(
      {
        id: 'q',
        metrics: ['engaged_ms'],
        filters: [{ dim: 'path', op: 'eq', value: '/', scope: 'hit' }],
      },
      [],
      sites(1),
    );
    expect(hit).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('groups session metrics by the session-only dims, values bound as ever', () => {
    const compiled = compile({
      metrics: ['visits', 'bounce_rate'],
      dim: 'entry_path',
      filters: [{ dim: 'exit_path', op: 'eq', value: '/bye' }],
    });
    expect(compiled.statements.map((s) => s.table)).toEqual(['sessions']);
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('s.entry_path AS "entry_path"');
    expect(statement?.sql).toContain('WHERE s.exit_path = ?');
    expect(statement?.params).toContain('/bye');
  });

  it('rejects event metrics crossed with session-only dimensions', () => {
    const byDim = compileMetricQuery(
      { id: 'q', metrics: ['pageviews'], dim: 'entry_path' },
      [],
      sites(1),
    );
    expect(byDim).toHaveProperty(['error', 'code'], 'unsupported');
    expect(byDim).toHaveProperty(
      ['error', 'message'],
      expect.stringContaining("session-level 'entry_path'"),
    );

    const byFilter = compileMetricQuery(
      { id: 'q', metrics: ['visitors'], filters: [{ dim: 'exit_path', op: 'eq', value: '/' }] },
      [],
      sites(1),
    );
    expect(byFilter).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('rejects a query whose dims block both tables, naming both blockers', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['visits'], dim: 'path', dim2: 'entry_path' },
      [],
      sites(1),
    );
    expect(compiled).toHaveProperty(['error', 'code'], 'unsupported');
    expect(compiled).toHaveProperty(
      ['error', 'message'],
      expect.stringContaining("both 'path' and the session-level 'entry_path'"),
    );
  });

  it("scope:'session' on a session-only dim reads the session attribute, blocking nothing", () => {
    // On the sessions table it is the column itself…
    const sessions = compile({
      metrics: ['visits'],
      filters: [{ dim: 'entry_path', op: 'eq', value: '/', scope: 'session' }],
    });
    expect(sessions.statements[0]?.sql).toContain('(s.entry_path = ?)');
    // …and on the events table a semi-join through the same bounds CTE, so an
    // event metric can still be narrowed to sessions that entered somewhere.
    const events = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'entry_path', op: 'eq', value: '/', scope: 'session' }],
    });
    const sql = events.statements[0]?.sql ?? '';
    expect(events.statements.map((s) => s.table)).toEqual(['events']);
    expect(sql).toContain('e.session_id IN (SELECT s.id');
    expect(sql).toContain(
      'sessions s JOIN bounds ON s.site_id = bounds.site_id\n  AND s.local_date BETWEEN bounds.from_date AND bounds.to_date',
    );
    expect(events.statements[0]?.params).toContain('/');
  });

  it('applies global filters to every statement of a split query', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['pageviews', 'visits'] },
      [{ dim: 'country', op: 'eq', value: 'US' }],
      sites(1),
    );
    if (isQueryError(compiled)) throw new Error('expected success');
    expect(compiled.statements).toHaveLength(2);
    for (const statement of compiled.statements) {
      expect(statement.sql).toMatch(/WHERE [es]\.country = \?/);
      expect(statement.params).toEqual(['US']);
    }
  });
});

describe('prop:<key> dimensions (docs/03 § Props)', () => {
  it('groups by json_extract over a BOUND path — the key never enters the SQL text', () => {
    const compiled = compile({ metrics: ['pageviews'], dim: 'prop:plan' });
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('json_extract(e.props, ?) AS "prop:plan"');
    // The path exists only as a bound value — never as a literal in the text.
    expect(statement?.sql).not.toContain('$."');
    expect(statement?.params).toEqual(['$."plan"']);
    expect(compiled.groupKeys).toEqual(['prop:plan']);
  });

  it('filters bind the path before the value, on every op incl. is_null and glob', () => {
    const eq = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'prop:plan', op: 'eq', value: 'pro' }],
    });
    expect(eq.statements[0]?.sql).toContain('WHERE json_extract(e.props, ?) = ?');
    expect(eq.statements[0]?.params).toEqual(['$."plan"', 'pro']);

    const isNull = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'prop:plan', op: 'is_null' }],
    });
    expect(isNull.statements[0]?.sql).toContain('WHERE json_extract(e.props, ?) IS NULL');
    expect(isNull.statements[0]?.params).toEqual(['$."plan"']);

    const glob = compile({
      metrics: ['pageviews'],
      filters: [{ dim: 'prop:page', op: 'glob', value: '/docs/*' }],
    });
    expect(glob.statements[0]?.sql).toContain('WHERE json_extract(e.props, ?) GLOB ?');
    expect(glob.statements[0]?.params).toEqual(['$."page"', '/docs/*']);
  });

  it('a hostile key never reaches the compiler: the schema is the wall', () => {
    // The bound path is built from a key this regex admitted and nothing else,
    // so the injection suite's job here is proving the regex refuses a quote.
    expect(DimensionSchema.safeParse('prop:a"||(SELECT 1)||"').success).toBe(false);
    expect(DimensionSchema.safeParse('prop:plan').success).toBe(true);
  });

  it('is event-only: session metrics under a prop dim earn the standing refusal', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['bounce_rate'], dim: 'prop:plan' },
      [],
      sites(1),
    );
    expect(isQueryError(compiled)).toBe(true);
    // And `visits` re-routes to the events table, exactly as under `path`.
    const visits = compile({ metrics: ['visits'], dim: 'prop:plan' });
    expect(visits.statements[0]?.table).toBe('events');
    expect(visits.statements[0]?.sql).toContain('COUNT(DISTINCT');
  });

  it("scope:'session' works through the generic path: EXISTS over e2.props", () => {
    const compiled = compile({
      metrics: ['visits'],
      filters: [{ dim: 'prop:plan', op: 'eq', value: 'pro', scope: 'session' }],
    });
    const statement = compiled.statements[0];
    expect(statement?.table).toBe('sessions');
    expect(statement?.sql).toContain(
      "EXISTS (SELECT 1 FROM events e2 WHERE e2.session_id = s.id AND e2.type != 'ping' AND json_extract(e2.props, ?) = ?)",
    );
    expect(statement?.params).toEqual(['$."plan"', 'pro']);
  });
});
