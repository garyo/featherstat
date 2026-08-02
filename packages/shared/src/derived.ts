import { z } from 'zod';
import type { Metric } from './index.ts';

// ---------------------------------------------------------------------------
// Derived metrics (docs/04 § 3) — operator-defined arithmetic over the metric
// vocabulary. The expression is parsed here into a tiny AST and evaluated in
// JS after aggregation; it is never eval'd and never becomes SQL, so CLAUDE.md
// invariant 9 is untouched: the closed vocabulary is the only thing that can
// name a column.
//
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := metric | number | '(' expr ')'
// ---------------------------------------------------------------------------

export type DerivedOp = '+' | '-' | '*' | '/';

export type DerivedAst =
  | { metric: Metric }
  | { value: number }
  | { op: DerivedOp; left: DerivedAst; right: DerivedAst };

/** Enough for any honest ratio-with-a-fudge-factor; past this is obfuscation. */
export const MAX_DERIVED_AST_NODES = 16;
export const MAX_DERIVED_EXPR_LENGTH = 200;

/** The wire spelling of a derived metric in a query's `metrics` array. */
export const DERIVED_METRIC_PREFIX = 'd:';
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const REF_PATTERN = /^d:[a-z][a-z0-9_]{0,31}$/;

/** `d:<name>` — how a request names a derived metric beside the built-in ones. */
export type DerivedMetricRef = `d:${string}`;

export const DerivedMetricRefSchema = z.custom<DerivedMetricRef>(
  (raw) => typeof raw === 'string' && REF_PATTERN.test(raw),
  'not a derived metric reference (d:<name>)',
);

export function isDerivedMetricRef(metric: string): metric is DerivedMetricRef {
  return REF_PATTERN.test(metric);
}

/** The stored name behind a `d:<name>` reference. */
export function derivedNameOf(ref: DerivedMetricRef): string {
  return ref.slice(DERIVED_METRIC_PREFIX.length);
}

/**
 * The operand vocabulary — every `MetricSchema` member, spelled out because
 * this module must not import a VALUE from `index.ts` (which imports the ref
 * schema below, so the cycle would evaluate this first — the same constraint
 * `measures.ts` documents for `ACTION_HIT_TYPES`). The `Record<Metric, true>`
 * shape makes it exhaustive both ways under tsc; `derived.test.ts` holds it
 * against `MetricSchema.options` besides.
 */
const OPERANDS: Record<Metric, true> = {
  visitors: true,
  visits: true,
  pageviews: true,
  events: true,
  outlinks: true,
  downloads: true,
  engaged_ms: true,
  engaged_sessions: true,
  avg_engagement: true,
  bounce_rate: true,
  views_per_visit: true,
  event_value_sum: true,
};

const METRIC_NAMES = new Set<string>(Object.keys(OPERANDS));

interface Parser {
  tokens: string[];
  at: number;
  nodes: number;
}

/**
 * Parses one expression to its AST, or throws an `Error` naming what is wrong.
 * The throw is the contract: schema validation wraps it in a zod issue, and the
 * executor wraps it in an honest per-query error — nothing downstream ever
 * holds a half-parsed expression.
 */
export function parseDerivedExpr(expr: string): DerivedAst {
  if (expr.length > MAX_DERIVED_EXPR_LENGTH) {
    throw new Error(`an expression is at most ${MAX_DERIVED_EXPR_LENGTH} characters`);
  }
  const parser: Parser = { tokens: tokenize(expr), at: 0, nodes: 0 };
  const ast = parseExpr(parser);
  const trailing = parser.tokens[parser.at];
  if (trailing !== undefined) throw new Error(`unexpected '${trailing}'`);
  if (derivedMetricsOf(ast).length === 0) {
    throw new Error('an expression must reference at least one metric');
  }
  return ast;
}

const TOKEN = /[a-z][a-z0-9_]*|\d+(?:\.\d+)?|[-+*/()]|\S/gy;

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < expr.length) {
    if (expr[at] === ' ') {
      at++;
      continue;
    }
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(expr);
    if (match === null) throw new Error(`unexpected character at position ${at}`);
    tokens.push(match[0]);
    at = TOKEN.lastIndex;
  }
  return tokens;
}

function node(parser: Parser, ast: DerivedAst): DerivedAst {
  parser.nodes++;
  if (parser.nodes > MAX_DERIVED_AST_NODES) {
    throw new Error(`an expression holds at most ${MAX_DERIVED_AST_NODES} terms`);
  }
  return ast;
}

function parseExpr(parser: Parser): DerivedAst {
  let left = parseTerm(parser);
  while (parser.tokens[parser.at] === '+' || parser.tokens[parser.at] === '-') {
    const op = parser.tokens[parser.at] as DerivedOp;
    parser.at++;
    left = node(parser, { op, left, right: parseTerm(parser) });
  }
  return left;
}

function parseTerm(parser: Parser): DerivedAst {
  let left = parseFactor(parser);
  while (parser.tokens[parser.at] === '*' || parser.tokens[parser.at] === '/') {
    const op = parser.tokens[parser.at] as DerivedOp;
    parser.at++;
    left = node(parser, { op, left, right: parseFactor(parser) });
  }
  return left;
}

function parseFactor(parser: Parser): DerivedAst {
  const token = parser.tokens[parser.at];
  if (token === undefined) throw new Error('unexpected end of expression');
  if (token === '(') {
    parser.at++;
    const inner = parseExpr(parser);
    if (parser.tokens[parser.at] !== ')') throw new Error("expected ')'");
    parser.at++;
    return inner;
  }
  parser.at++;
  if (/^\d/.test(token)) {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`'${token}' is not a finite number`);
    return node(parser, { value });
  }
  if (!METRIC_NAMES.has(token)) throw new Error(`'${token}' is not a metric`);
  return node(parser, { metric: token as Metric });
}

/** Every metric the expression reads, deduplicated, in document order. */
export function derivedMetricsOf(ast: DerivedAst): Metric[] {
  const metrics: Metric[] = [];
  const walk = (n: DerivedAst): void => {
    if ('metric' in n) {
      if (!metrics.includes(n.metric)) metrics.push(n.metric);
    } else if ('op' in n) {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(ast);
  return metrics;
}

/**
 * The expression's value over one row's aggregated metrics. `null` propagates:
 * an unknown operand makes the answer unknown, and a division by zero (or by
 * null) is unknown too — never `Infinity`, never a fabricated 0. The values
 * record is deliberately loose (a result row holds strings too); anything
 * that is not a finite number reads as unknown.
 */
export function evaluateDerived(
  ast: DerivedAst,
  values: Readonly<Record<string, unknown>>,
): number | null {
  if ('value' in ast) return ast.value;
  if ('metric' in ast) {
    const value = values[ast.metric];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  const left = evaluateDerived(ast.left, values);
  const right = evaluateDerived(ast.right, values);
  if (left === null || right === null) return null;
  switch (ast.op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? null : left / right;
  }
}

// ---------------------------------------------------------------------------
// Admin API shapes (docs/04 § 5)
// ---------------------------------------------------------------------------

export const DerivedMetricCreateSchema = z.object({
  /** Also the wire name (as `d:<name>`), so it must never shadow a built-in. */
  name: z
    .string()
    .regex(NAME_PATTERN, 'lowercase letters, digits and underscores, starting with a letter')
    .refine((name) => !METRIC_NAMES.has(name), 'shadows a built-in metric'),
  expr: z
    .string()
    .min(1)
    .max(MAX_DERIVED_EXPR_LENGTH)
    .superRefine((expr, ctx) => {
      try {
        parseDerivedExpr(expr);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
});
export type DerivedMetricCreate = z.infer<typeof DerivedMetricCreateSchema>;

/** `GET /api/derived-metrics` row — everything a client needs to offer the metric. */
export interface DerivedMetricInfo {
  id: number;
  name: string;
  expr: string;
  updatedAt: number;
}
