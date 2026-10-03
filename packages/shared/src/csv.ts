import type { Query, QueryResult, ResultRow } from './index.ts';

/**
 * One query's result as CSV (docs/04 § 3 "CSV export"). Shared so the server's
 * `?format=csv` negotiation and a future client-side export write byte-identical
 * files — and dependency-free, because a serializer with a dependency is a
 * serializer the SPA cannot afford to bundle.
 *
 * The dialect is pure RFC 4180: a field containing a comma, quote, CR or LF is
 * quoted with `""` doubling — load-bearing, because dimension values are
 * visitor-controlled text — records end CRLF, UTF-8 without BOM. Null (and a
 * sparse row's missing cell) is an empty field, never a zero: the server does
 * not manufacture numbers in JSON and must not here. Rates stay fractions in
 * 0–1, exactly as the `measures` header declares them.
 *
 * Deliberately NO spreadsheet formula-escaping: a value starting with `=`, `+`,
 * `-` or `@` is emitted verbatim. Prefixing a quote or tab would corrupt the
 * data for every non-spreadsheet consumer to defend one class of importer;
 * we emit standard CSV, and a consumer pasting untrusted text into a formula
 * engine owns how cells are interpreted there.
 */
export function resultToCsv(query: Query, result: QueryResult): string {
  const compare = result.compare;
  const columns = columnsOf(
    query,
    compare === undefined ? result.rows : [...result.rows, ...compare],
  );
  const lines: string[] = [];
  const header = compare === undefined ? columns : ['period', ...columns];
  lines.push(header.map(field).join(','));
  emit(lines, result.rows, columns, compare === undefined ? undefined : 'current');
  if (compare !== undefined) emit(lines, compare, columns, 'previous');
  return `${lines.join('\r\n')}\r\n`;
}

function emit(
  lines: string[],
  rows: readonly ResultRow[],
  columns: readonly string[],
  period: string | undefined,
): void {
  for (const row of rows) {
    const cells = columns.map((column) => field(row[column] ?? null));
    lines.push((period === undefined ? cells : [field(period), ...cells]).join(','));
  }
}

/**
 * The column set, derived from the rows themselves so this function needs no
 * compiler — but never in object-key order alone. Known columns come first in
 * the order the compiler emits groups (bucket, then dim, dim2) followed by the
 * metrics in REQUEST order; anything else the rows carry (a derived metric's
 * components, a goal `cr`'s `visits` denominator) follows sorted, so the file
 * is deterministic for one request whatever the executor's merge produced.
 */
function columnsOf(query: Query, rows: readonly ResultRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  const columns: string[] = [];
  for (const key of knownColumns(query)) {
    if (seen.delete(key)) columns.push(key);
  }
  columns.push(...[...seen].sort());
  return columns;
}

/** Each kind's natural column order; a metric query's is its group keys then its metrics. */
function knownColumns(query: Query): readonly string[] {
  if (!('kind' in query)) {
    const columns: string[] = [];
    if (query.bucket !== undefined) columns.push('bucket');
    if (query.dim !== undefined) columns.push(query.dim);
    if (query.dim2 !== undefined) columns.push(query.dim2);
    columns.push(...query.metrics);
    return columns;
  }
  switch (query.kind) {
    case 'transitions':
      return ['step', 'from', 'to', 'sessions'];
    case 'flows':
      return ['steps', 'sessions', 'avg_engaged_ms', 'exit_rate'];
    case 'dwell':
      return [
        'path',
        'views_measured',
        'avg_page_ms',
        'max_page_ms',
        'views_scrolled',
        'avg_scroll_pct',
      ];
    case 'adjacency':
      return ['label', 'sessions'];
    case 'distribution':
      return ['bucket', 'legs'];
    case 'changes':
      return ['dim', 'value', 'current', 'previous', 'delta', 'share'];
    case 'missing':
      return ['path', 'hits', 'referred', 'ref_domain', 'ref_path', 'last_seen'];
  }
}

/** One RFC 4180 field. A flows signature (string array) reads as its steps joined with " > ". */
function field(value: ResultRow[string] | undefined): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(' > ') : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
