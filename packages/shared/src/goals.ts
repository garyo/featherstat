import { z } from 'zod';
import { type SegmentFilterNode, SegmentFilterNodeSchema } from './filters.ts';

// ---------------------------------------------------------------------------
// Goals (docs/04 § 3): saved queries over the filter grammar. A goal completes
// once per session — ≥1 non-ping event matching its filters — and its metrics
// ride the ordinary metric vocabulary as `goal:<id>:<aspect>`. The stored AST
// goes through the same filter compiler as everything else (invariant 9);
// nothing here is a new query language.
// ---------------------------------------------------------------------------

export const GOAL_ASPECTS = ['conversions', 'cr', 'value'] as const;
export type GoalAspect = (typeof GOAL_ASPECTS)[number];

const GOAL_REF_PATTERN = /^goal:([1-9]\d{0,8}):(conversions|cr|value)$/;

/** `goal:<id>:<aspect>` — how a query names a goal metric beside the built-ins. */
export type GoalMetricRef = `goal:${number}:${GoalAspect}`;

// A pattern-checked string rather than `z.custom`, so the schema stays
// representable in JSON Schema (the MCP tool listing converts it).
export const GoalMetricRefSchema = z
  .string()
  .regex(GOAL_REF_PATTERN, 'not a goal metric reference (goal:<id>:conversions|cr|value)')
  .transform((raw) => raw as GoalMetricRef);

export function isGoalMetricRef(metric: string): metric is GoalMetricRef {
  return GOAL_REF_PATTERN.test(metric);
}

/** The goal id and aspect behind a `goal:` reference. */
export function goalRefParts(ref: GoalMetricRef): { id: number; aspect: GoalAspect } {
  const match = GOAL_REF_PATTERN.exec(ref);
  if (match === null) throw new Error(`'${ref}' is not a goal metric reference`);
  return { id: Number(match[1]), aspect: match[2] as GoalAspect };
}

/**
 * What one completion is worth: the completing event's own `event_value`, a
 * fixed amount per conversion, or nothing (`value` then answers null).
 */
export const GoalValueExprSchema = z
  .union([z.literal('event_value'), z.object({ fixed: z.number().finite() })])
  .nullable();
export type GoalValueExpr = z.infer<typeof GoalValueExprSchema>;

/** The `goals.value_expr` column: 'event_value' | 'fixed:<number>' | NULL. */
export function encodeGoalValueExpr(expr: GoalValueExpr): string | null {
  if (expr === null) return null;
  return expr === 'event_value' ? 'event_value' : `fixed:${expr.fixed}`;
}

/** Fails closed: an unreadable stored column reads as "no value", never a guess. */
export function parseGoalValueExpr(column: string | null): GoalValueExpr {
  if (column === null || column === '') return null;
  if (column === 'event_value') return 'event_value';
  if (column.startsWith('fixed:')) {
    const fixed = Number(column.slice('fixed:'.length));
    if (Number.isFinite(fixed)) return { fixed };
  }
  return null;
}

/** Filter trees one goal may AND together (implicit AND, like a request's `filters`). */
export const MAX_GOAL_FILTERS = 16;

/** The `goals.filters` column's shape — writes validate it, reads re-parse it. */
export const GoalFiltersSchema = z.array(SegmentFilterNodeSchema).min(1).max(MAX_GOAL_FILTERS);

/**
 * What a stored goal is. Filters use `SegmentFilterNodeSchema` — the grammar
 * WITHOUT segment refs, so a goal can never depend on a segment edit it does
 * not see (and the executor can compile it without an expansion pass).
 */
export const GoalCreateSchema = z.object({
  name: z.string().min(1).max(64),
  filters: GoalFiltersSchema,
  valueExpr: GoalValueExprSchema.default(null),
  /** Optional completions target — display only, never a computation input. */
  target: z.number().finite().positive().nullable().default(null),
});
export type GoalCreate = z.infer<typeof GoalCreateSchema>;

/** `GET /api/goals?site=` row — everything a client needs to offer the goal. */
export interface GoalInfo {
  id: number;
  siteId: number;
  name: string;
  filters: SegmentFilterNode[];
  valueExpr: GoalValueExpr;
  target: number | null;
  updatedAt: number;
}
