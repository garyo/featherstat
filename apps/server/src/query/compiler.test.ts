import { ENGAGEMENT_THRESHOLD_MS, isQueryError, type MetricQuery } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { type CompiledQuery, compileMetricQuery } from './compiler.ts';

function compile(query: Partial<MetricQuery> & Pick<MetricQuery, 'metrics'>): CompiledQuery {
  const compiled = compileMetricQuery({ id: 'q', ...query }, [], 1);
  if (isQueryError(compiled)) {
    throw new Error(`unexpected compile error: ${compiled.error.message}`);
  }
  return compiled;
}

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
      1,
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
    const byDim = compileMetricQuery({ id: 'q', metrics: ['bounce_rate'], dim: 'title' }, [], 1);
    expect(byDim).toHaveProperty(['error', 'code'], 'unsupported');

    const byFilter = compileMetricQuery(
      { id: 'q', metrics: ['engaged_ms'], filters: [{ dim: 'path', op: 'eq', value: '/' }] },
      [],
      1,
    );
    expect(byFilter).toHaveProperty(['error', 'code'], 'unsupported');

    const byBucket = compileMetricQuery(
      { id: 'q', metrics: ['engaged_ms'], bucket: 'hour' },
      [],
      1,
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
      1,
    );
    expect(compiled).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('emits one bounds tuple per site and a bound LIMIT', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['pageviews'], dim: 'path', limit: 5 },
      [],
      3,
    );
    if (isQueryError(compiled)) throw new Error('expected success');
    const statement = compiled.statements[0];
    expect(statement?.sql).toContain('VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)');
    expect(statement?.sql).toContain('ORDER BY "pageviews" DESC, 1');
    expect(statement?.sql).toContain('LIMIT ?');
    expect(statement?.params).toEqual([5]);
  });

  it('applies global filters to every statement of a split query', () => {
    const compiled = compileMetricQuery(
      { id: 'q', metrics: ['pageviews', 'visits'] },
      [{ dim: 'country', op: 'eq', value: 'US' }],
      1,
    );
    if (isQueryError(compiled)) throw new Error('expected success');
    expect(compiled.statements).toHaveLength(2);
    for (const statement of compiled.statements) {
      expect(statement.sql).toMatch(/WHERE [es]\.country = \?/);
      expect(statement.params).toEqual(['US']);
    }
  });
});
