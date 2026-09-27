import { type CampaignField, isValidTimezone, localClock } from '@featherstat/shared';
import type { EventRow, NewSite, SessionRow } from '../db/index.ts';
import { type NormalizedUtm, plainNormalizer } from '../pipeline/campaigns.ts';
import { canonicalReferrerDomain } from '../pipeline/referrers.ts';

/**
 * Pure row mappers for the Matomo importer (docs/06): plain Matomo 5 row
 * objects in, our docs/03 row shapes out. No database, no connection — the
 * streaming adapter (importer.ts) owns SQL and batching; fixtures exercise
 * these directly.
 */

// ---------------------------------------------------------------------------
// Matomo source row shapes (the column subset the importer selects)
// ---------------------------------------------------------------------------

export interface MatomoSiteRow {
  idsite: number;
  name: string;
  main_url: string;
  /** 'YYYY-MM-DD HH:MM:SS', UTC — Matomo stores all DATETIMEs in UTC. */
  ts_created: string;
  timezone: string;
}

/** Visit columns shared by `matomo_log_visit` and the action join (per-visit context). */
interface MatomoVisitContext {
  referer_type: number | null;
  referer_name: string | null;
  referer_url: string | null;
  campaign_name?: string | null;
  campaign_source?: string | null;
  campaign_medium?: string | null;
  config_browser_name: string | null;
  config_browser_version?: string | null;
  config_os: string | null;
  config_device_type: number | null;
  config_resolution?: string | null;
  location_browser_lang?: string | null;
  location_country: string | null;
  location_region: string | null;
  location_city: string | null;
  /** DECIMAL columns arrive as strings from mysql2. */
  location_latitude?: number | string | null;
  location_longitude?: number | string | null;
}

export interface MatomoVisitRow extends MatomoVisitContext {
  idvisit: number;
  idsite: number;
  /** BINARY(8) — a Buffer from mysql2. */
  idvisitor: Uint8Array;
  visit_first_action_time: string;
  visit_last_action_time: string;
  /** Seconds; Matomo's span-based visit duration (docs/06: best engaged_ms proxy). */
  visit_total_time: number | null;
  visit_total_actions: number | null;
  visit_total_events: number | null;
  /** Entry/exit page actions, joined from `matomo_log_action` by the adapter. */
  entry_url_name?: string | null;
  entry_url_prefix?: number | null;
  exit_url_name?: string | null;
  exit_url_prefix?: number | null;
}

/** `matomo_log_link_visit_action` ⨝ `matomo_log_action` (×4) ⨝ `matomo_log_visit`. */
export interface MatomoActionRow extends MatomoVisitContext {
  idlink_va: number;
  idvisit: number;
  idsite: number;
  idvisitor: Uint8Array;
  server_time: string;
  /** Event value. */
  custom_float: number | string | null;
  url_type: number | null;
  url_name: string | null;
  url_prefix: number | null;
  name_type: number | null;
  name_name: string | null;
  event_category: string | null;
  event_action: string | null;
}

// ---------------------------------------------------------------------------
// Matomo enums
// ---------------------------------------------------------------------------

/** `log_action.url_prefix`: the scheme Matomo stripped before storing the name. */
const URL_PREFIXES = ['http://', 'http://www.', 'https://', 'https://www.'] as const;

// log_action.type — the subset our model records; the rest (site search,
// ecommerce, content) is skipped by classifyAction.
const ACTION_PAGE_URL = 1;
const ACTION_OUTLINK = 2;
const ACTION_DOWNLOAD = 3;
const ACTION_PAGE_TITLE = 4;
const ACTION_EVENT_NAME = 12;

/** Matomo `Common::REFERRER_TYPE_*` → our `ref_type` vocabulary (docs/03). */
const REFERRER_TYPES: Record<number, string> = {
  1: 'direct',
  2: 'search',
  3: 'referral',
  6: 'campaign',
  7: 'social',
};

/** device-detector short codes → the names ua-parser v1 emits, for dimension continuity. */
const BROWSER_NAMES: Record<string, string> = {
  CH: 'Chrome',
  CM: 'Chrome',
  CI: 'Chrome',
  FF: 'Firefox',
  FM: 'Firefox',
  SF: 'Safari',
  MF: 'Mobile Safari',
  IE: 'IE',
  ED: 'Edge',
  OP: 'Opera',
  OM: 'Opera',
  SM: 'Samsung Browser',
  BR: 'Brave',
  VI: 'Vivaldi',
  UC: 'UC Browser',
  AN: 'Android Browser',
};

const OS_NAMES: Record<string, string> = {
  WIN: 'Windows',
  MAC: 'Mac OS',
  LIN: 'Linux',
  AND: 'Android',
  IOS: 'iOS',
  UBT: 'Ubuntu',
  COS: 'Chrome OS',
};

/** device-detector numeric device types → docs/03 `device_type`. */
const DEVICE_TYPES: Record<number, string> = {
  0: 'desktop',
  1: 'mobile', // smartphone
  2: 'tablet',
  3: 'mobile', // feature phone
  10: 'mobile', // phablet
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Matomo's site timezone is an IANA name or a manual offset from its settings
 * list — `UTC+10`, `UTC-3.5`, `UTC+5.75` — which no runtime resolves. Whole
 * hours become the IANA `Etc/GMT∓h` zone (POSIX sign: east of Greenwich is
 * minus); fractional ones a fixed `±hhmm` offset. Null when neither resolves.
 */
export function matomoTimezone(timezone: string): string | null {
  if (isValidTimezone(timezone)) return timezone;
  const match = /^UTC([+-])(\d{1,2})(?:\.(\d+))?$/.exec(timezone);
  if (match === null) return null;
  const [, sign = '+', hours = '0', fraction = '0'] = match;
  const minutes = Math.round(Number(`0.${fraction}`) * 60);
  let zone: string;
  if (minutes > 0) {
    zone = `${sign}${hours.padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
  } else if (Number(hours) === 0) {
    zone = 'UTC';
  } else {
    zone = `Etc/GMT${sign === '+' ? '-' : '+'}${Number(hours)}`;
  }
  return isValidTimezone(zone) ? zone : null;
}

/** Throws on a timezone `matomoTimezone` cannot map: the site's every row would land on wrong days. */
export function mapSite(
  row: MatomoSiteRow,
  aliasUrls: readonly string[] = [],
): NewSite & { timezone: string } {
  const timezone = matomoTimezone(row.timezone);
  if (timezone === null) {
    throw new Error(
      `Matomo site ${row.idsite} has timezone '${row.timezone}', which maps to no zone this ` +
        'runtime knows — fix it in Matomo (or pick an IANA name) and re-run',
    );
  }
  const domains: string[] = [];
  for (const url of [row.main_url, ...aliasUrls]) {
    const host = hostnameOf(url);
    if (host !== null && !domains.includes(host)) domains.push(host);
  }
  const created = utcMs(row.ts_created);
  return {
    id: row.idsite, // preserved verbatim (docs/06 R2)
    name: row.name,
    domains,
    timezone,
    ...(created === null ? {} : { created_at: created }),
  };
}

/**
 * `matomo_log_visit` → `sessions`. Returns null for rows missing the
 * essentials (unparseable times, malformed idvisitor) — the adapter counts those.
 */
export function mapVisit(row: MatomoVisitRow, timezone: string): SessionRow | null {
  const started = utcMs(row.visit_first_action_time);
  const visitorId = visitorIdOf(row.idvisitor);
  if (started === null || visitorId === null) return null;
  const local = localClock(timezone, started);
  return {
    id: sessionIdForVisit(row.idvisit),
    site_id: row.idsite,
    visitor_id: visitorId,
    started_at: started,
    last_seen_at: utcMs(row.visit_last_action_time) ?? started,
    local_date: local.date,
    local_hour: local.hour,
    entry_path: actionPath(row.entry_url_name, row.entry_url_prefix),
    exit_path: actionPath(row.exit_url_name, row.exit_url_prefix),
    // Matomo has no pure pageview counter on the visit; total_actions
    // (pages + outlinks + downloads + searches) is the closest column.
    pageviews: row.visit_total_actions ?? 0,
    events: row.visit_total_events ?? 0,
    engaged_ms: Math.max(0, row.visit_total_time ?? 0) * 1000,
    ...attribution(row),
    browser: browserName(row.config_browser_name),
    os: osName(row.config_os),
    device_type: deviceType(row.config_device_type),
    country: row.location_country ? row.location_country.toUpperCase() : null,
    region: row.location_region ?? null,
    city: row.location_city ?? null,
  };
}

/**
 * One joined action row → `events` row, minus `seq` (a per-visit running
 * position only the adapter's stream can assign). Rows outside our model
 * (site search, ecommerce, content) map to null.
 */
export function mapAction(row: MatomoActionRow, timezone: string): Omit<EventRow, 'seq'> | null {
  const ts = utcMs(row.server_time);
  const visitorId = visitorIdOf(row.idvisitor);
  if (ts === null || visitorId === null) return null;
  const action = classifyAction(row);
  if (action === null) return null;
  const local = localClock(timezone, ts);
  return {
    site_id: row.idsite,
    ts,
    local_date: local.date,
    local_hour: local.hour,
    visitor_id: visitorId,
    session_id: sessionIdForVisit(row.idvisit),
    // Attribution is per-visit in Matomo, so every row gets the session's
    // values — the same denormalization docs/03 prescribes for live ingest.
    ...attribution(row),
    browser: browserName(row.config_browser_name),
    browser_version: row.config_browser_version ?? null,
    os: osName(row.config_os),
    device_type: deviceType(row.config_device_type),
    screen: row.config_resolution ?? null,
    lang: row.location_browser_lang ?? null,
    country: row.location_country ? row.location_country.toUpperCase() : null,
    region: row.location_region ?? null,
    city: row.location_city ?? null,
    lat: coordinate(row.location_latitude),
    lon: coordinate(row.location_longitude),
    ...action,
  };
}

/**
 * Deterministic 8-byte session id (big-endian idvisit): both table streams and
 * every re-run derive the same id, which is what makes the sessions upsert
 * idempotent. idvisit is globally unique across Matomo sites.
 */
export function sessionIdForVisit(idvisit: number): Uint8Array {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, BigInt(idvisit));
  return id;
}

/** Rebuilds the full URL Matomo split into `url_prefix` + name. */
export function actionUrl(
  name: string | null | undefined,
  prefix: number | null | undefined,
): string | null {
  if (!name) return null;
  if (/^https?:\/\//i.test(name)) return name; // outlinks/downloads keep their scheme
  return (URL_PREFIXES[prefix ?? 0] ?? URL_PREFIXES[0]) + name;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ActionFields = Pick<
  EventRow,
  | 'type'
  | 'hostname'
  | 'path'
  | 'title'
  | 'target_url'
  | 'event_category'
  | 'event_action'
  | 'event_name'
  | 'event_value'
>;

function classifyAction(row: MatomoActionRow): ActionFields | null {
  const url = actionUrl(row.url_name, row.url_prefix);
  const fields: ActionFields = {
    type: 'pageview',
    hostname: null,
    path: null,
    title: row.name_type === ACTION_PAGE_TITLE ? (row.name_name ?? null) : null,
    target_url: null,
    event_category: null,
    event_action: null,
    event_name: null,
    event_value: null,
  };
  if (row.event_category && row.event_action) {
    fields.type = 'event';
    fields.event_category = row.event_category;
    fields.event_action = row.event_action;
    fields.event_name = row.name_type === ACTION_EVENT_NAME ? (row.name_name ?? null) : null;
    fields.event_value = coordinate(row.custom_float);
    if (row.url_type === ACTION_PAGE_URL && url !== null) {
      const page = urlParts(url);
      fields.hostname = page.hostname;
      fields.path = page.path;
    }
    return fields;
  }
  if (row.url_type === ACTION_OUTLINK || row.url_type === ACTION_DOWNLOAD) {
    fields.type = row.url_type === ACTION_OUTLINK ? 'outlink' : 'download';
    fields.target_url = url;
    fields.title = null;
    return fields;
  }
  if (row.url_type === ACTION_PAGE_URL && url !== null) {
    const page = urlParts(url);
    fields.hostname = page.hostname;
    fields.path = page.path;
    return fields;
  }
  if (fields.title !== null) return fields; // Matomo title-only pageview (docs/04)
  return null;
}

function attribution(
  row: MatomoVisitContext,
): Pick<
  SessionRow,
  | 'ref_domain'
  | 'ref_domain_raw'
  | 'ref_type'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_source_raw'
  | 'utm_medium_raw'
  | 'utm_campaign_raw'
> {
  const type =
    row.referer_type === null || row.referer_type === undefined
      ? null
      : (REFERRER_TYPES[row.referer_type] ?? null);
  // The shared canonicalization (docs/03 § Attribution): imported rows land in
  // the same shape ingest writes, so the Referrers report never splits a source
  // by where its rows came from.
  let host = hostnameOf(row.referer_url ?? '')?.toLowerCase() ?? null;
  // For plain website referrers Matomo stores the domain as the referrer name.
  if (host === null && type === 'referral' && row.referer_name) {
    host = row.referer_name.toLowerCase();
  }
  const domain = host === null ? null : canonicalReferrerDomain(host);
  // The shared ingest normalizer (docs/03 § Campaigns), alias-free: an import
  // targets a fresh file whose alias table is empty; later alias edits reach
  // these rows through the ordinary backfill.
  const source = normalized('source', row.campaign_source ?? null);
  const medium = normalized('medium', row.campaign_medium ?? null);
  const campaign = normalized(
    'campaign',
    row.campaign_name ?? (type === 'campaign' ? (row.referer_name ?? null) : null),
  );
  return {
    ref_domain: domain,
    ref_domain_raw: domain === host ? null : host,
    ref_type: type,
    utm_source: source.normalized,
    utm_medium: medium.normalized,
    utm_campaign: campaign.normalized,
    utm_source_raw: source.raw ?? null,
    utm_medium_raw: medium.raw ?? null,
    utm_campaign_raw: campaign.raw ?? null,
  };
}

function normalized(field: CampaignField, value: string | null): NormalizedUtm {
  return value === null ? { normalized: null } : plainNormalizer(0, field, value);
}

/** Matomo DATETIMEs are UTC strings (the adapter connects with `dateStrings`). */
function utcMs(datetime: string | null | undefined): number | null {
  if (!datetime) return null;
  const ms = Date.parse(`${datetime.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function visitorIdOf(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.byteLength === 8 ? value : null;
}

function browserName(code: string | null): string | null {
  return code ? (BROWSER_NAMES[code] ?? code) : null;
}

function osName(code: string | null): string | null {
  return code ? (OS_NAMES[code] ?? code) : null;
}

function deviceType(code: number | null): string | null {
  return code === null ? null : (DEVICE_TYPES[code] ?? 'other');
}

/** DECIMAL/DOUBLE columns arrive as number or string depending on the driver. */
function coordinate(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function actionPath(
  name: string | null | undefined,
  prefix: number | null | undefined,
): string | null {
  const url = actionUrl(name, prefix);
  return url === null ? null : urlParts(url).path;
}

function urlParts(url: string): { hostname: string | null; path: string | null } {
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname, path: parsed.pathname + parsed.search };
  } catch {
    return { hostname: null, path: url };
  }
}
