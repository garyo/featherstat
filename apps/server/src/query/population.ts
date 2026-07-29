import { HitTypeSchema, POPULATIONS, type Population } from '@featherstat/shared';

/**
 * A named population (packages/shared § measures) → the row predicate that
 * selects it. The one place in the tree that turns "which rows does this count"
 * into SQL: metrics declare a population and never a predicate, and the
 * non-metric readers of the same idea — the sequence kinds, the realtime hub's
 * feed seeding — ask here rather than spelling `type != 'ping'` again.
 *
 * The literals are members of the closed `HitTypeSchema` enum, never client
 * input, so they are written into the SQL text rather than bound; every value
 * that came from a request is still a parameter (CLAUDE.md invariant 9).
 */

/**
 * The predicate selecting `population` among `alias`'s rows, or `null` when it
 * is every row of that table — the caller then has nothing to test.
 *
 * Metric queries compose this into a `CASE WHEN`, never a `WHERE`: one SELECT
 * serves metrics of mixed population (`visitors` over `actions` beside
 * `pageviews` over its own), so a population that filtered rows would either be
 * wrong or force one query per population and a merge in JS.
 */
export function populationSql(population: Population, alias: string): string | null {
  const spec = POPULATIONS[population];
  if (spec.rows === 'visits') {
    // "Measured" for a visit is time on the clock (docs/03): a single-hit visit
    // is unmeasurable, not zero-length.
    return spec.measured ? `${alias}.engaged_ms > 0` : null;
  }
  if (spec.measured) {
    // `measured_pageviews` is selected by a window function over a session's
    // rows (query/dwell.ts), not by anything a row can be tested against. No
    // metric declares it, and compiler.test.ts holds that line.
    throw new Error(`population '${population}' is not a row predicate`);
  }
  const types = spec.hitTypes;
  if (types === null) return null;
  const excluded = HitTypeSchema.options.filter((type) => !types.includes(type));
  if (excluded.length === 0) return null;
  // Prefer whichever side is shorter — `!= 'ping'` reads better than the four
  // types it leaves, and is the same test SQLite would run either way.
  if (excluded.length === 1) return `${alias}.type != '${excluded[0]}'`;
  if (types.length === 1) return `${alias}.type = '${types[0]}'`;
  return `${alias}.type IN (${types.map((type) => `'${type}'`).join(', ')})`;
}

/** The same predicate as a `WHERE` fragment: `1` where every row qualifies. */
export function populationWhere(population: Population, alias: string): string {
  return populationSql(population, alias) ?? '1';
}
