import { describe, expect, it } from 'vitest';
import {
  DerivedMetricCreateSchema,
  DerivedMetricRefSchema,
  derivedMetricsOf,
  derivedNameOf,
  evaluateDerived,
  isDerivedMetricRef,
  MAX_DERIVED_AST_NODES,
  parseDerivedExpr,
} from './derived.ts';
import { MetricSchema } from './index.ts';

describe('parseDerivedExpr', () => {
  it('parses precedence and parentheses the arithmetic way', () => {
    // visits + pageviews * 2 groups the product first…
    expect(
      evaluateDerived(parseDerivedExpr('visits + pageviews * 2'), { visits: 1, pageviews: 3 }),
    ).toBe(7);
    // …and parentheses override it.
    expect(
      evaluateDerived(parseDerivedExpr('(visits + pageviews) * 2'), { visits: 1, pageviews: 3 }),
    ).toBe(8);
    expect(
      evaluateDerived(parseDerivedExpr('pageviews / visits'), { visits: 4, pageviews: 6 }),
    ).toBe(1.5);
  });

  it('accepts every metric in the vocabulary as an operand', () => {
    for (const metric of MetricSchema.options) {
      expect(derivedMetricsOf(parseDerivedExpr(`${metric} * 2`))).toEqual([metric]);
    }
  });

  it('rejects anything that is not a metric, a number, or the four operators', () => {
    for (const bad of [
      'DROP TABLE events', // not a metric
      'd:other', // derived metrics cannot reference derived metrics
      'visits + nope',
      'visits ** 2', // no exponent
      '-visits', // no unary minus
      'visits +', // dangling operator
      '(visits', // unbalanced
      'visits pageviews', // trailing junk
      '42', // a constant references no metric
      '', // nothing at all
      'visits + 1e9', // exponent literals are not in the grammar
    ]) {
      expect(() => parseDerivedExpr(bad), bad).toThrow();
    }
  });

  it(`caps the AST at ${MAX_DERIVED_AST_NODES} nodes`, () => {
    const atCap = Array.from({ length: 8 }, () => 'visits').join(' + '); // 8 leaves + 7 ops = 15
    expect(() => parseDerivedExpr(atCap)).not.toThrow();
    const overCap = Array.from({ length: 9 }, () => 'visits').join(' + ');
    expect(() => parseDerivedExpr(overCap)).toThrow(/at most/);
  });

  it('caps the expression length', () => {
    expect(() => parseDerivedExpr(`visits ${' '.repeat(300)}`)).toThrow(/characters/);
  });
});

describe('evaluateDerived', () => {
  const ratio = parseDerivedExpr('pageviews / visits');

  it('propagates null: an unknown operand makes the answer unknown', () => {
    expect(evaluateDerived(ratio, { pageviews: null, visits: 4 })).toBeNull();
    expect(evaluateDerived(ratio, { visits: 4 })).toBeNull();
    // A non-numeric cell (a result row holds strings too) reads as unknown.
    expect(evaluateDerived(ratio, { pageviews: 'six', visits: 4 })).toBeNull();
  });

  it('answers null for division by zero or by null — never Infinity', () => {
    expect(evaluateDerived(ratio, { pageviews: 6, visits: 0 })).toBeNull();
    expect(evaluateDerived(ratio, { pageviews: 6, visits: null })).toBeNull();
  });

  it('evaluates subtraction and numeric literals', () => {
    const ast = parseDerivedExpr('pageviews - visits * 0.5');
    expect(evaluateDerived(ast, { pageviews: 6, visits: 4 })).toBe(4);
  });
});

describe('DerivedMetricRefSchema', () => {
  it('accepts d:<name> and nothing else', () => {
    expect(DerivedMetricRefSchema.safeParse('d:events_per_visit').success).toBe(true);
    for (const bad of ['events_per_visit', 'd:', 'd:Nope', 'd:9x', `d:${'x'.repeat(33)}`, 42]) {
      expect(DerivedMetricRefSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('round-trips through the name helpers', () => {
    expect(isDerivedMetricRef('d:x')).toBe(true);
    expect(isDerivedMetricRef('visits')).toBe(false);
    expect(derivedNameOf('d:events_per_visit')).toBe('events_per_visit');
  });
});

describe('DerivedMetricCreateSchema', () => {
  it('accepts a well-formed definition', () => {
    expect(
      DerivedMetricCreateSchema.safeParse({ name: 'events_per_visit', expr: 'events / visits' })
        .success,
    ).toBe(true);
  });

  it('refuses a name that shadows a built-in metric', () => {
    for (const metric of MetricSchema.options) {
      expect(
        DerivedMetricCreateSchema.safeParse({ name: metric, expr: 'events / visits' }).success,
        metric,
      ).toBe(false);
    }
  });

  it('refuses bad names and unparseable expressions', () => {
    expect(DerivedMetricCreateSchema.safeParse({ name: 'Nope', expr: 'visits' }).success).toBe(
      false,
    );
    expect(DerivedMetricCreateSchema.safeParse({ name: 'ok', expr: 'visits +' }).success).toBe(
      false,
    );
    expect(DerivedMetricCreateSchema.safeParse({ name: 'ok', expr: '42' }).success).toBe(false);
  });

  it('keeps the spelled-out operand list in step with MetricSchema', () => {
    // derived.ts must not import a value from index.ts (import cycle), so the
    // operand vocabulary is written out — this is what stops the two drifting.
    for (const metric of MetricSchema.options) {
      expect(() => parseDerivedExpr(metric), metric).not.toThrow();
    }
  });
});
