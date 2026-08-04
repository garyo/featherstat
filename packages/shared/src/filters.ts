import { z } from 'zod';

// ---------------------------------------------------------------------------
// Filter grammar (docs/04 § 3) — the closed vocabulary CLAUDE.md invariant 9
// rests on. Dimensions and ops are enums; every value is data the compiler
// binds as a parameter, never SQL.
// ---------------------------------------------------------------------------

export const BaseDimensionSchema = z.enum([
  'path',
  'hostname',
  'title',
  'target_url',
  'ref_domain',
  'ref_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device_type',
  'screen',
  'lang',
  'event_category',
  'event_action',
  'event_name',
  'local_hour',
  'weekday',
  'site',
  'entry_path',
  'exit_path',
  /** Derived at query time from the campaigns registry (docs/03 § Campaigns):
   * registered | unregistered | untagged. Never stored, never rolled up. */
  'campaign_status',
]);
/** The closed dimension enum — what every exhaustive `Record<…>` table keys on. */
export type BaseDimension = z.infer<typeof BaseDimensionSchema>;

/** The charset a prop key may use — shared by the ingest bag and the `prop:` dim. */
export const PROP_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;
const PROP_DIMENSION_PATTERN = /^prop:[a-z0-9_-]{1,32}$/;

/**
 * A custom-prop dimension: `prop:<key>` over `events.props` (docs/03 § Props).
 * Event-only and open-ended — the key is operator vocabulary, not ours — so it
 * lives BESIDE the enum: exhaustive tables stay keyed by `BaseDimension`, and
 * every consumer of `Dimension` routes prop dims explicitly (`isPropDimension`)
 * before indexing one.
 */
export type PropDimension = `prop:${string}`;

// A pattern-checked string rather than `z.custom`, so the schema stays
// representable in JSON Schema (the MCP tool listing converts it).
export const PropDimensionSchema = z
  .string()
  .regex(PROP_DIMENSION_PATTERN, 'not a prop:<key> dimension')
  .transform((value) => value as PropDimension);

export const DimensionSchema = z.union([BaseDimensionSchema, PropDimensionSchema]);
export type Dimension = BaseDimension | PropDimension;

export function isPropDimension(dim: string): dim is PropDimension {
  return PROP_DIMENSION_PATTERN.test(dim);
}

/** The bare key of a `prop:<key>` dimension. */
export function propKeyOf(dim: PropDimension): string {
  return dim.slice('prop:'.length);
}

export const FilterOpSchema = z.enum(['eq', 'neq', 'in', 'contains', 'starts', 'is_null', 'glob']);
export type FilterOp = z.infer<typeof FilterOpSchema>;

/**
 * What a leaf predicate ranges over: the row itself (`hit`, the default), or
 * the session containing it (`session` — "the session had ≥1 non-ping event
 * matching this"). Session scope is what lets an event-level dimension filter
 * a session-shaped question honestly: "journeys of sessions that visited
 * /pricing" asks about the session, not the step.
 */
export const FilterScopeSchema = z.enum(['hit', 'session']);
export type FilterScope = z.infer<typeof FilterScopeSchema>;

/** GLOB is cheap but not free: a hostile pattern is refused here, not timed out. */
export const MAX_GLOB_LENGTH = 256;
export const MAX_GLOB_WILDCARDS = 8;

export const FilterLeafSchema = z
  .object({
    dim: DimensionSchema,
    op: FilterOpSchema,
    /** Absent only for `is_null`, which names a group (e.g. direct traffic) that has no value. */
    value: z.union([z.string().max(2048), z.array(z.string().max(2048)).max(100)]).optional(),
    /** Absent reads as `hit` — today's semantics; stated only to widen them. */
    scope: FilterScopeSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.op === 'is_null' ? f.value !== undefined : f.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "'is_null' takes no value; every other op requires one",
      });
    }
    if (f.op !== 'glob') return;
    if (typeof f.value !== 'string') {
      ctx.addIssue({ code: 'custom', message: "'glob' takes a single string pattern" });
      return;
    }
    if (f.value.length > MAX_GLOB_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: `a glob pattern is at most ${MAX_GLOB_LENGTH} characters`,
      });
    }
    const wildcards = f.value.length - f.value.replaceAll('*', '').length;
    if (wildcards > MAX_GLOB_WILDCARDS) {
      ctx.addIssue({
        code: 'custom',
        message: `a glob pattern carries at most ${MAX_GLOB_WILDCARDS} '*' wildcards`,
      });
    }
  });
export type FilterLeaf = z.infer<typeof FilterLeafSchema>;

/** The v1 flat-filter names — a v1 filter IS a leaf, so old clients never notice the tree. */
export const FilterSchema = FilterLeafSchema;
export type Filter = FilterLeaf;

/**
 * The filter tree: a leaf, or boolean composition over subtrees. A top-level
 * ARRAY of nodes is an implicit AND — exactly the v1 flat-filter shape, which
 * is what keeps every stored dashboard and every old client valid unchanged.
 *
 * `{segment: id}` names a saved segment (docs/04 § 3) and exists only on the
 * REQUEST side: the server substitutes the stored tree before anything is
 * compiled, so the compiler and the workers never see one. A stored segment
 * is `SegmentFilterNode` — the same grammar WITHOUT the ref, which is what
 * makes cycles impossible by construction rather than by check.
 */
export type SegmentFilterNode =
  | FilterLeaf
  | { all: SegmentFilterNode[] }
  | { any: SegmentFilterNode[] }
  | { not: SegmentFilterNode };

export type FilterNode =
  | FilterLeaf
  | { all: FilterNode[] }
  | { any: FilterNode[] }
  | { not: FilterNode }
  | { segment: number };

/** A leaf is depth 1; each wrapper adds one. Four is a lot of nesting already. */
export const MAX_FILTER_DEPTH = 4;
export const MAX_FILTER_LEAVES = 32;
/** How many top-level nodes the implicit AND may hold. */
export const MAX_FILTER_NODES = 16;

export const SegmentFilterNodeSchema: z.ZodType<SegmentFilterNode> = z.lazy(() =>
  z.union([
    FilterLeafSchema,
    z.object({ all: z.array(SegmentFilterNodeSchema).min(1).max(MAX_FILTER_LEAVES) }),
    z.object({ any: z.array(SegmentFilterNodeSchema).min(1).max(MAX_FILTER_LEAVES) }),
    z.object({ not: SegmentFilterNodeSchema }),
  ]),
);

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    FilterLeafSchema,
    z.object({ all: z.array(FilterNodeSchema).min(1).max(MAX_FILTER_LEAVES) }),
    z.object({ any: z.array(FilterNodeSchema).min(1).max(MAX_FILTER_LEAVES) }),
    z.object({ not: FilterNodeSchema }),
    z.object({ segment: z.number().int().positive() }),
  ]),
);

/** A leaf is depth 1; each `all`/`any`/`not` wrapper adds one. */
export function filterDepth(node: FilterNode): number {
  if ('all' in node) return 1 + Math.max(...node.all.map(filterDepth));
  if ('any' in node) return 1 + Math.max(...node.any.map(filterDepth));
  if ('not' in node) return 1 + filterDepth(node.not);
  return 1;
}

/** Every leaf anywhere in the tree, in document order. A segment ref holds
 * none of its own — its leaves exist only after the server substitutes it. */
export function filterLeaves(node: FilterNode): FilterLeaf[] {
  if ('all' in node) return node.all.flatMap(filterLeaves);
  if ('any' in node) return node.any.flatMap(filterLeaves);
  if ('not' in node) return filterLeaves(node.not);
  if ('segment' in node) return [];
  return [node];
}

/** Every segment id referenced anywhere in the tree, in document order. */
export function filterSegmentRefs(node: FilterNode): number[] {
  if ('all' in node) return node.all.flatMap(filterSegmentRefs);
  if ('any' in node) return node.any.flatMap(filterSegmentRefs);
  if ('not' in node) return filterSegmentRefs(node.not);
  if ('segment' in node) return [node.segment];
  return [];
}

/** Every dimension mentioned anywhere in the tree. */
export function filterDims(node: FilterNode): Set<Dimension> {
  return new Set(filterLeaves(node).map((leaf) => leaf.dim));
}

/**
 * The `filters` field of a request or a query: implicit AND over the entries,
 * with the tree caps enforced where the whole tree is finally in view.
 */
export const FiltersSchema = z
  .array(FilterNodeSchema)
  .max(MAX_FILTER_NODES)
  .superRefine((nodes, ctx) => {
    let leaves = 0;
    for (const node of nodes) {
      if (filterDepth(node) > MAX_FILTER_DEPTH) {
        ctx.addIssue({
          code: 'custom',
          message: `a filter tree nests at most ${MAX_FILTER_DEPTH} levels`,
        });
      }
      leaves += filterLeaves(node).length;
    }
    if (leaves > MAX_FILTER_LEAVES) {
      ctx.addIssue({
        code: 'custom',
        message: `filters name at most ${MAX_FILTER_LEAVES} predicates in total`,
      });
    }
  });
