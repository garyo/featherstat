import {
  type BaseDimension,
  type Dimension,
  type Filter,
  type FilterNode,
  FilterNodeSchema,
  FilterSchema,
  filterDepth,
  filterLeaves,
  isPropDimension,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_FILTER_NODES,
  propKeyOf,
} from '@featherstat/shared';

/**
 * Filter chips (docs/05: active dimension filters as removable chips, living in
 * the URL). One `f` search param per top-level node, in one of three spellings:
 *
 *   `dim:op:value`  a leaf — `dim:op` for `is_null`, the value component-encoded
 *                   so `:` and `,` inside visitor-controlled values can never
 *                   split a chip (`in` joins on `,` after encoding, likewise)
 *   `segment:<id>`  a saved segment the server substitutes (docs/04 § 3)
 *   `~<payload>`    any node the flat spelling cannot say — `all`/`any`/`not`,
 *                   or a leaf that names `scope` — as base64url JSON
 *
 * The leaf spelling is the one that was here first and it is unchanged, so every
 * link and every shipped template that predates the expression editor still
 * parses. `~` opens no dimension name and `segment` is no dimension at all, so
 * the three cannot collide. Anything unparseable is dropped rather than raised:
 * a mangled link opens the dashboard.
 */

/** Exhaustive over the closed enum: a new dimension in `packages/shared` fails to
 * compile until labeled. `prop:` dims are open-ended — `dimLabel` names them by key. */
export const DIM_LABELS: Record<BaseDimension, string> = {
  path: 'Page',
  hostname: 'Hostname',
  title: 'Title',
  target_url: 'Outbound link',
  ref_domain: 'Referrer',
  ref_type: 'Referrer type',
  utm_source: 'Source',
  utm_medium: 'Medium',
  utm_campaign: 'Campaign',
  country: 'Country',
  region: 'Region',
  city: 'City',
  browser: 'Browser',
  os: 'OS',
  device_type: 'Device',
  screen: 'Screen',
  lang: 'Language',
  event_category: 'Event category',
  event_action: 'Event action',
  event_name: 'Event name',
  local_hour: 'Hour',
  weekday: 'Weekday',
  site: 'Site',
  entry_path: 'Entry page',
  exit_path: 'Exit page',
  campaign_status: 'Campaign status',
};

/** A dimension's display name; a `prop:` dim reads as its bare key. */
export function dimLabel(dim: Dimension): string {
  return isPropDimension(dim) ? propKeyOf(dim) : DIM_LABELS[dim];
}

/** What a chip (or a breakdown row) names the NULL group of a dimension. */
export const NULL_LABELS: Partial<Record<BaseDimension, string>> = {
  ref_domain: 'Direct',
  country: 'Unknown',
};

export function nullLabelFor(dim: Dimension): string {
  return (isPropDimension(dim) ? undefined : NULL_LABELS[dim]) ?? '(none)';
}

const OP_WORDS: Record<Filter['op'], string> = {
  eq: '',
  neq: 'not',
  in: 'in',
  contains: 'contains',
  starts: 'starts with',
  is_null: '',
  glob: 'matches',
};

/** One leaf in chip words: `Referrer: google.com`, `Page contains /blog`. */
function leafLabel(filter: Filter): string {
  const dim = dimLabel(filter.dim);
  const scoped = filter.scope === 'session' ? `${dim} (session)` : dim;
  if (filter.op === 'is_null') return `${scoped}: ${nullLabelFor(filter.dim)}`;
  const value = Array.isArray(filter.value) ? filter.value.join(', ') : (filter.value ?? '');
  const word = OP_WORDS[filter.op];
  return word === '' ? `${scoped}: ${value}` : `${scoped} ${word} ${value}`;
}

/**
 * Chip text for a whole node. A group reads as its children joined by the word
 * it means, parenthesized when nested so `a and (b or c)` cannot be misread as
 * `(a and b) or c` — the chip is the only place the shape is visible without
 * opening the editor.
 */
export function chipLabel(node: FilterNode, segmentNames?: ReadonlyMap<number, string>): string {
  return nodeLabel(node, segmentNames, true);
}

function nodeLabel(
  node: FilterNode,
  names: ReadonlyMap<number, string> | undefined,
  top: boolean,
): string {
  if ('segment' in node) return names?.get(node.segment) ?? `Segment ${node.segment}`;
  if ('not' in node) return `not ${nodeLabel(node.not, names, false)}`;
  if (!('all' in node || 'any' in node)) return leafLabel(node);
  const parts = 'all' in node ? node.all : node.any;
  const joined = parts
    .map((child) => nodeLabel(child, names, false))
    .join('all' in node ? ' and ' : ' or ');
  return top || parts.length < 2 ? joined : `(${joined})`;
}

/** The flat spelling, for the leaves that have one. */
function serializeLeaf(filter: Filter): string {
  if (filter.op === 'is_null') return `${filter.dim}:${filter.op}`;
  const value = Array.isArray(filter.value)
    ? filter.value.map(encodeURIComponent).join(',')
    : encodeURIComponent(filter.value ?? '');
  return `${filter.dim}:${filter.op}:${value}`;
}

/** A leaf keeps the flat spelling only when it carries nothing the flat spelling drops. */
function isFlatLeaf(node: FilterNode): node is Filter {
  return !('all' in node || 'any' in node || 'not' in node || 'segment' in node);
}

export function serializeFilter(node: FilterNode): string {
  if ('segment' in node) return `${SEGMENT_PREFIX}${node.segment}`;
  if (isFlatLeaf(node) && node.scope === undefined) return serializeLeaf(node);
  return `${TREE_PREFIX}${encodePayload(JSON.stringify(node))}`;
}

const SEGMENT_PREFIX = 'segment:';
const TREE_PREFIX = '~';

/** Anything unparseable is dropped — a mangled link opens the dashboard, not an error. */
export function parseFilter(raw: string): FilterNode | undefined {
  if (raw.startsWith(TREE_PREFIX)) {
    const json = decodePayload(raw.slice(TREE_PREFIX.length));
    if (json === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return undefined;
    }
    const node = FilterNodeSchema.safeParse(parsed);
    return node.success ? node.data : undefined;
  }
  if (raw.startsWith(SEGMENT_PREFIX)) {
    const id = Number(raw.slice(SEGMENT_PREFIX.length));
    return Number.isInteger(id) && id > 0 ? { segment: id } : undefined;
  }
  const parts = raw.split(':');
  // A `prop:<key>` dim carries the one ':' a dimension may contain.
  const dimEnd = parts[0] === 'prop' ? 2 : 1;
  const dim = parts.slice(0, dimEnd).join(':');
  const [op, ...rest] = parts.slice(dimEnd);
  const candidate: Record<string, unknown> = { dim, op };
  if (op === 'is_null') {
    if (rest.length > 0) return undefined; // is_null takes no value — trailing junk is junk
  } else {
    if (rest.length === 0) return undefined;
    const encoded = rest.join(':');
    candidate.value = op === 'in' ? encoded.split(',').map(decodeSafe) : decodeSafe(encoded);
  }
  const parsed = FilterSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Every entry that parses AND still fits the shared caps. Over-cap entries are
 * dropped from the end rather than failing the lot: a link that says too much
 * should still open the part of it that is sayable.
 */
export function parseFilters(raw: readonly string[]): FilterNode[] {
  const filters: FilterNode[] = [];
  let leaves = 0;
  for (const entry of raw) {
    if (filters.length >= MAX_FILTER_NODES) break;
    const filter = parseFilter(entry);
    if (filter === undefined) continue;
    if (filterDepth(filter) > MAX_FILTER_DEPTH) continue;
    const count = filterLeaves(filter).length;
    if (leaves + count > MAX_FILTER_LEAVES) continue;
    leaves += count;
    filters.push(filter);
  }
  return filters;
}

export function sameFilter(a: FilterNode, b: FilterNode): boolean {
  return serializeFilter(a) === serializeFilter(b);
}

export function sameFilters(a: readonly FilterNode[], b: readonly FilterNode[]): boolean {
  return a.length === b.length && a.every((filter, i) => sameFilter(filter, b[i] as FilterNode));
}

function decodeSafe(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded; // a stray % is a literal, not a crash
  }
}

/**
 * base64url over UTF-8 bytes: values carry em-dashes and worse, and `btoa`
 * refuses anything above U+00FF. Byte-at-a-time rather than a spread, so a long
 * expression cannot overflow the argument list.
 */
function encodePayload(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodePayload(payload: string): string | undefined {
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
