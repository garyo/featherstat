import { type Dimension, type Filter, FilterSchema } from '@featherstat/shared';

/**
 * Filter chips (docs/05: active dimension filters as removable chips, living in
 * the URL). One `f` search param per chip: `dim:op` for `is_null`, else
 * `dim:op:value` with the value component-encoded — so `:` and `,` inside
 * visitor-controlled values can never split a chip. `in` values join on `,`
 * after encoding, for the same reason.
 */

/** Exhaustive: a new dimension in `packages/shared` fails to compile until labeled. */
export const DIM_LABELS: Record<Dimension, string> = {
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
};

/** What a chip (or a breakdown row) names the NULL group of a dimension. */
export const NULL_LABELS: Partial<Record<Dimension, string>> = {
  ref_domain: 'Direct',
  country: 'Unknown',
};

export function nullLabelFor(dim: Dimension): string {
  return NULL_LABELS[dim] ?? '(none)';
}

const OP_WORDS: Record<Filter['op'], string> = {
  eq: '',
  neq: 'not',
  in: 'in',
  contains: 'contains',
  starts: 'starts with',
  is_null: '',
};

/** Chip text: `Referrer: google.com`, `Referrer: Direct`, `Page: contains /blog`. */
export function chipLabel(filter: Filter): string {
  const dim = DIM_LABELS[filter.dim];
  if (filter.op === 'is_null') return `${dim}: ${nullLabelFor(filter.dim)}`;
  const value = Array.isArray(filter.value) ? filter.value.join(', ') : (filter.value ?? '');
  const word = OP_WORDS[filter.op];
  return word === '' ? `${dim}: ${value}` : `${dim} ${word} ${value}`;
}

export function serializeFilter(filter: Filter): string {
  if (filter.op === 'is_null') return `${filter.dim}:${filter.op}`;
  const value = Array.isArray(filter.value)
    ? filter.value.map(encodeURIComponent).join(',')
    : encodeURIComponent(filter.value ?? '');
  return `${filter.dim}:${filter.op}:${value}`;
}

/** Anything unparseable is dropped — a mangled link opens the dashboard, not an error. */
export function parseFilter(raw: string): Filter | undefined {
  const [dim, op, ...rest] = raw.split(':');
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

export function parseFilters(raw: readonly string[]): Filter[] {
  const filters: Filter[] = [];
  for (const entry of raw) {
    const filter = parseFilter(entry);
    if (filter !== undefined) filters.push(filter);
  }
  return filters;
}

export function sameFilter(a: Filter, b: Filter): boolean {
  return serializeFilter(a) === serializeFilter(b);
}

export function sameFilters(a: readonly Filter[], b: readonly Filter[]): boolean {
  return a.length === b.length && a.every((filter, i) => sameFilter(filter, b[i] as Filter));
}

function decodeSafe(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded; // a stray % is a literal, not a crash
  }
}
