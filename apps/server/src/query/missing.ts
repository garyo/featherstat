import {
  type Dimension,
  type FilterLeaf,
  type FilterNode,
  filterLeaves,
  type MissingQuery,
  type SiteWindow,
} from '@featherstat/shared';
import {
  boundsCte,
  type CompileError,
  invalidLeaf,
  isRolling,
  leafOpSql,
  unsupported,
} from './compiler.ts';

/**
 * MissingQuery → parameterized SQL (docs/03 § Not-found hits, docs/04 § 3): the
 * paths asked for that do not exist, each with its most common referring page.
 *
 * Ranked by the hits that arrived with a referrer first: a link on someone's
 * page — or on the site's own — is a broken link somebody can fix, while a
 * direct hit is a typo or a scanner's guess. Hits stored past the per-day cap
 * are counted in `missing_daily` and never reach a row here.
 *
 * A not-found hit belongs to no visit, so a filter can only ask about what the
 * hit itself carries. Anything else — a session-scoped leaf, a page title, a
 * campaign — has no honest answer here and compiles to an error entry rather
 * than to a wider question under the narrow label.
 */

export interface CompiledMissing {
  kind: 'missing';
  sql: string;
  /** Bound after the per-site bounds tuples, in textual order. */
  params: readonly (string | number)[];
}

/** Dimensions a not-found hit carries, and the column each reads. `path` is the path asked for. */
const COLUMNS: Partial<Record<Dimension, string>> = {
  path: 'm.path',
  ref_type: 'm.ref_type',
  ref_domain: 'm.ref_domain',
  device_type: 'm.device_type',
  country: 'm.country',
};

export function compileMissingQuery(
  query: MissingQuery,
  filters: readonly FilterNode[],
  windows: readonly SiteWindow[],
): CompiledMissing | CompileError {
  const leaves = filters.flatMap(filterLeaves);
  const invalid = invalidLeaf(leaves);
  if (invalid !== undefined) return invalid;
  for (const leaf of leaves) {
    if (leaf.scope === 'session' || COLUMNS[leaf.dim] === undefined) {
      return unsupported(
        `broken links belong to no visit and cannot honestly apply the filter '${leaf.dim}'`,
      );
    }
  }

  const params: (string | number)[] = [];
  const where = filters.map((node) => nodeSql(node, params));
  const scope = [
    'm.site_id = bounds.site_id',
    'm.local_date BETWEEN bounds.from_date AND bounds.to_date',
  ];
  if (isRolling(windows)) {
    scope.push('m.ts >= bounds.from_ts', 'm.ts < bounds.to_ts');
  }
  params.push(query.limit);
  const sql = [
    `${boundsCte(windows)},`,
    'hits AS (',
    '  SELECT m.path, m.local_date, m.ref_domain, m.ref_path',
    `  FROM missing_hits m JOIN bounds ON ${scope.join(' AND ')}`,
    ...(where.length > 0 ? [`  WHERE ${where.join(' AND ')}`] : []),
    '),',
    // One referring page per path: the commonest, ties broken by name so the
    // answer is stable from one request to the next.
    'referrers AS (',
    '  SELECT path, ref_domain, ref_path,',
    '    ROW_NUMBER() OVER (PARTITION BY path ORDER BY COUNT(*) DESC, ref_domain, ref_path) AS rank',
    '  FROM hits WHERE ref_domain IS NOT NULL',
    '  GROUP BY path, ref_domain, ref_path',
    ')',
    'SELECT h.path AS path, COUNT(*) AS hits, COUNT(h.ref_domain) AS referred,',
    '  r.ref_domain AS ref_domain, r.ref_path AS ref_path, MAX(h.local_date) AS last_seen',
    'FROM hits h LEFT JOIN referrers r ON r.path IS h.path AND r.rank = 1',
    'GROUP BY h.path',
    'ORDER BY referred DESC, hits DESC, h.path',
    'LIMIT ?',
  ].join('\n');
  return { kind: 'missing', sql, params };
}

/** One FilterNode over `missing_hits`, with the compiler's NULL-safe `not` and op semantics. */
function nodeSql(node: FilterNode, params: (string | number)[]): string {
  if ('all' in node) return `(${node.all.map((child) => nodeSql(child, params)).join(' AND ')})`;
  if ('any' in node) return `(${node.any.map((child) => nodeSql(child, params)).join(' OR ')})`;
  if ('not' in node) return `NOT COALESCE((${nodeSql(node.not, params)}), 0)`;
  if ('segment' in node) {
    throw new Error(`segment ref ${node.segment} reached the compiler unexpanded`);
  }
  return leafSql(node, params);
}

function leafSql(leaf: FilterLeaf, params: (string | number)[]): string {
  const column = COLUMNS[leaf.dim];
  if (column === undefined) throw new Error(`'${leaf.dim}' filter reached missing_hits`);
  return leafOpSql(column, leaf, params, false);
}
