import {
  isQueryError,
  type QueryRequest,
  type QueryResponse,
  type QueryResult,
  type Range,
  type ResultRow,
} from '@analytics/shared';
import {
  type Db,
  dataVersion,
  getSite,
  listSites,
  type Site,
  stmt,
  withReadSnapshot,
} from '../db/index.ts';
import { type CompiledQuery, compileMetricQuery, metricEmpty } from './compiler.ts';
import { compareWindow, type DateWindow, resolveWindow } from './ranges.ts';
import { type CompiledSequence, compileSequenceQuery } from './sequences.ts';

/**
 * Runs a whole QueryRequest — every widget of a dashboard view — inside one
 * read snapshot, so all results describe the same instant (docs/04 § 3).
 */

/** Requests for a site id that does not exist are a client error, not an empty result. */
export class UnknownSiteError extends Error {}

export interface SiteWindow extends DateWindow {
  siteId: number;
}

/**
 * Per-site inclusive local-date windows for a request scope. Presets resolve per
 * site timezone, so these are an input to the answer — the ETag must cover them.
 */
export function resolveSiteWindows(
  db: Db,
  site: QueryRequest['site'],
  range: Range,
  now: number,
): SiteWindow[] {
  return resolveSites(db, site).map((s) => ({
    siteId: s.id,
    ...resolveWindow(range, s.timezone, now),
  }));
}

export interface ExecuteOptions {
  /** Clock used to resolve range presets — tests pin it. */
  now?: number;
}

export function executeQueryRequest(
  db: Db,
  request: QueryRequest,
  options: ExecuteOptions = {},
): QueryResponse {
  const started = performance.now();
  const now = options.now ?? Date.now();
  return withReadSnapshot(db, () => {
    const windows = resolveSiteWindows(db, request.site, request.range, now);
    const compare = request.compare;
    const compareWindows =
      compare === undefined
        ? undefined
        : windows.map((window) => ({ siteId: window.siteId, ...compareWindow(window, compare) }));

    const results: QueryResponse['results'] = {};
    for (const query of request.queries) {
      const queryStarted = performance.now();
      if ('kind' in query) {
        // Sequence kinds answer only the primary window: a journey comparison
        // has no defined shape (docs/04), so `compare` is never fabricated.
        const compiled = compileSequenceQuery(query, request.filters ?? [], windows.length);
        if (isQueryError(compiled)) {
          results[query.id] = compiled;
          continue;
        }
        const entry: QueryResult = { rows: runSequence(db, compiled, windows) };
        entry.ms = elapsed(queryStarted);
        results[query.id] = entry;
        continue;
      }
      const compiled = compileMetricQuery(query, request.filters ?? [], windows.length);
      if (isQueryError(compiled)) {
        results[query.id] = compiled;
        continue;
      }
      const entry: QueryResult = { rows: runCompiled(db, compiled, windows) };
      if (compareWindows !== undefined) entry.compare = runCompiled(db, compiled, compareWindows);
      entry.ms = elapsed(queryStarted);
      results[query.id] = entry;
    }
    return { results, meta: { generatedInMs: elapsed(started), dataVersion: dataVersion(db) } };
  });
}

function resolveSites(db: Db, scope: QueryRequest['site']): Site[] {
  if (scope === 'all') return listSites(db);
  const site = getSite(db, scope);
  if (site === undefined) throw new UnknownSiteError(`unknown site id ${scope}`);
  return [site];
}

function runSequence(
  db: Db,
  compiled: CompiledSequence,
  windows: readonly SiteWindow[],
): ResultRow[] {
  if (windows.length === 0) return [];
  const rows = stmt<ResultRow>(db, compiled.sql).all(
    ...boundsParams(windows),
    ...compiled.params,
  ) as ResultRow[];
  if (compiled.kind === 'flows') {
    // The signature travels as JSON text in SQL; clients get the parsed array.
    for (const row of rows) row.steps = JSON.parse(row.steps as string) as string[];
  }
  return rows;
}

function boundsParams(windows: readonly SiteWindow[]): (string | number)[] {
  const bounds: (string | number)[] = [];
  for (const window of windows) bounds.push(window.siteId, window.from, window.to);
  return bounds;
}

function runCompiled(db: Db, compiled: CompiledQuery, windows: readonly SiteWindow[]): ResultRow[] {
  if (windows.length === 0) return [];
  const bounds = boundsParams(windows);

  const first = compiled.statements[0];
  if (compiled.ordered && first !== undefined) {
    return stmt<ResultRow>(db, first.sql).all(...bounds, ...first.params) as ResultRow[];
  }

  // A query mixing session- and event-shaped metrics ran once per table; join the
  // partial rows on the group key and fill the gaps with each metric's empty value.
  const merged = new Map<string, ResultRow>();
  for (const statement of compiled.statements) {
    const rows = stmt<ResultRow>(db, statement.sql).all(...bounds, ...statement.params);
    for (const raw of rows as ResultRow[]) {
      // JSON per component: SQL NULL must never collide with a literal "null" value.
      const key = compiled.groupKeys
        .map((groupKey) => JSON.stringify(raw[groupKey] ?? null))
        .join('\u0000');
      let row = merged.get(key);
      if (row === undefined) {
        row = {};
        for (const groupKey of compiled.groupKeys) row[groupKey] = raw[groupKey] ?? null;
        for (const metric of compiled.metrics) row[metric] = metricEmpty(metric);
        merged.set(key, row);
      }
      for (const metric of statement.metrics) row[metric] = raw[metric] ?? metricEmpty(metric);
    }
  }
  const rows = sortRows([...merged.values()], compiled);
  return compiled.limit === undefined ? rows : rows.slice(0, compiled.limit);
}

/** Mirrors the SQL ordering of single-statement queries (compiler.orderClause). */
function sortRows(rows: ResultRow[], compiled: CompiledQuery): ResultRow[] {
  const metric = compiled.metrics[0];
  const dimKey = compiled.groupKeys[0];
  if (metric === undefined || dimKey === undefined) return rows;
  rows.sort((a, b) => {
    if (compiled.hasBucket) {
      const byBucket = compareValues(a.bucket, b.bucket);
      if (byBucket !== 0 || compiled.groupKeys.length === 1) return byBucket;
      return compareMetric(a[metric], b[metric]);
    }
    const byMetric = compareMetric(a[metric], b[metric]);
    return byMetric !== 0 ? byMetric : compareValues(a[dimKey], b[dimKey]);
  });
  return rows;
}

/** Descending, nulls last. */
function compareMetric(a: unknown, b: unknown): number {
  const left = typeof a === 'number' ? a : null;
  const right = typeof b === 'number' ? b : null;
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  // SQLite sorts NULL first in ASC order; the JS path must agree with the SQL path.
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10;
}
