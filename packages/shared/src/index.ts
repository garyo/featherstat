import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants (docs/03)
// ---------------------------------------------------------------------------

/** One day of UTC milliseconds — date arithmetic everywhere is plain UTC-ms math. */
export const DAY_MS = 86_400_000;
export const SESSION_TIMEOUT_MS = 30 * 60_000;
/** A session with less engaged time than this (and 1 pageview, no events) is a bounce. */
export const ENGAGEMENT_THRESHOLD_MS = 15_000;
/** Max gap credited to engaged time per ping/event (heartbeat interval + slack). */
export const PING_CLAMP_MS = 20_000;
export const BATCH_INTERVAL_MS = 200;
export const MAX_QUERIES_PER_BATCH = 32;
export const MAX_WIDGETS_PER_DASHBOARD = 24;

// Realtime SSE wire contract (docs/04 § 4)
/** "Active" = distinct visitors seen inside this window. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Cadence of the `active` recount event. */
export const ACTIVE_TICK_MS = 10_000;
/** Cadence of the keep-alive comment that stops proxies reaping the stream. */
export const HEARTBEAT_MS = 25_000;
/** Hits a fresh connection's `snapshot` is seeded with. */
export const SNAPSHOT_HITS = 50;

// ---------------------------------------------------------------------------
// Sites (docs/03)
// ---------------------------------------------------------------------------

/** Shape of the `sites.domains` JSON column; the first entry is canonical. */
export const SiteDomainsSchema = z.array(z.string());

/** `GET /api/sites` row — the public site directory the dashboard header lists. */
export const SiteInfoSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  domains: SiteDomainsSchema,
  timezone: z.string(),
});
export type SiteInfo = z.infer<typeof SiteInfoSchema>;

// ---------------------------------------------------------------------------
// Hits — normalized tracker input (docs/04 § 1–2)
// ---------------------------------------------------------------------------

export const HitTypeSchema = z.enum(['pageview', 'event', 'outlink', 'download', 'ping']);
export type HitType = z.infer<typeof HitTypeSchema>;

export const EventPayloadSchema = z.object({
  category: z.string().min(1).max(200),
  action: z.string().min(1).max(200),
  name: z.string().max(500).optional(),
  value: z.number().optional(),
});
export type EventPayload = z.infer<typeof EventPayloadSchema>;

export const HitSchema = z.object({
  siteId: z.number().int().positive(),
  type: HitTypeSchema,
  url: z.string().max(2048).optional(),
  title: z.string().max(512).optional(),
  referrer: z.string().max(2048).optional(),
  /** Outlink / download destination. */
  targetUrl: z.string().max(2048).optional(),
  event: EventPayloadSchema.optional(),
  screen: z.string().max(20).optional(),
  lang: z.string().max(35).optional(),
  /** Matomo `_id` (16 hex chars) — replaces the fingerprint input when present. */
  visitorId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  /** Site-provided user id; hashed with a stable per-site salt (opt-in, docs/03). */
  uid: z.string().max(200).optional(),
  /** Matomo `cip` — accepted and carried, consumed by nothing until authenticated server-side senders exist (docs/04). */
  clientIpOverride: z.string().max(45).optional(),
});
export type Hit = z.infer<typeof HitSchema>;

/** Transport context consumed during enrichment and then discarded (CLAUDE.md invariant 3). */
export interface HitContext {
  ip: string;
  userAgent: string;
  acceptLanguage?: string;
  /** Server clock, UTC ms. The tracker's own clock is never trusted. */
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Query API (docs/04 § 3)
// ---------------------------------------------------------------------------

export const MetricSchema = z.enum([
  'visitors',
  'visits',
  'pageviews',
  'events',
  'engaged_ms',
  'bounce_rate',
  'views_per_visit',
  'event_value_sum',
]);
export type Metric = z.infer<typeof MetricSchema>;

export const DimensionSchema = z.enum([
  'path',
  'hostname',
  'title',
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
]);
export type Dimension = z.infer<typeof DimensionSchema>;

export const BucketSchema = z.enum(['hour', 'day', 'week', 'month']);
export type Bucket = z.infer<typeof BucketSchema>;

/**
 * Dimensions only the events table carries: grouping or filtering by one makes
 * session-level metrics unanswerable (docs/04 § 3). The compiler enforces this
 * server-side; clients use the list to trim those metrics from a batch instead
 * of asking a question that can only error.
 */
export const EVENT_ONLY_DIMENSIONS = [
  'path',
  'hostname',
  'title',
  'screen',
  'lang',
  'event_category',
  'event_action',
  'event_name',
  'local_hour',
] as const satisfies readonly Dimension[];

/** Metrics only the sessions table can answer — unavailable under `EVENT_ONLY_DIMENSIONS`. */
export const SESSION_ONLY_METRICS = [
  'engaged_ms',
  'bounce_rate',
  'views_per_visit',
] as const satisfies readonly Metric[];

export const FilterSchema = z
  .object({
    dim: DimensionSchema,
    op: z.enum(['eq', 'neq', 'in', 'contains', 'starts', 'is_null']),
    /** Absent only for `is_null`, which names a group (e.g. direct traffic) that has no value. */
    value: z.union([z.string().max(2048), z.array(z.string().max(2048)).max(100)]).optional(),
  })
  .refine((f) => (f.op === 'is_null' ? f.value === undefined : f.value !== undefined), {
    message: "'is_null' takes no value; every other op requires one",
  });
export type Filter = z.infer<typeof FilterSchema>;

export const MetricQuerySchema = z.object({
  id: z.string().min(1).max(64),
  metrics: z.array(MetricSchema).min(1).max(8),
  dim: DimensionSchema.optional(),
  dim2: DimensionSchema.optional(),
  bucket: BucketSchema.optional(),
  filters: z.array(FilterSchema).max(16).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type MetricQuery = z.infer<typeof MetricQuerySchema>;

/** Sequence queries (journeys, docs/04): shapes that don't fit metric × dimension. */
export const SequenceQuerySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['transitions', 'flows']),
  /** transitions: how many steps out from entry; flows: signature length. */
  steps: z.number().int().min(2).max(8).default(4),
  limit: z.number().int().min(1).max(200).default(20),
});
export type SequenceQuery = z.infer<typeof SequenceQuerySchema>;

export const QuerySchema = z.union([SequenceQuerySchema, MetricQuerySchema]);
export type Query = z.infer<typeof QuerySchema>;

/** A real calendar date — the regex alone admits impossible months and days. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const ms = Date.parse(`${date}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(date);
  }, 'not a calendar date');

export const RangeSchema = z.union([
  z.object({ preset: z.enum(['today', '7d', '30d', '90d', 'mtd']) }),
  z.object({ from: isoDate, to: isoDate }),
]);
export type Range = z.infer<typeof RangeSchema>;

export const QueryRequestSchema = z.object({
  site: z.union([z.number().int().positive(), z.literal('all')]),
  range: RangeSchema,
  compare: z.enum(['previous', 'year']).optional(),
  filters: z.array(FilterSchema).max(16).optional(),
  queries: z.array(QuerySchema).min(1).max(MAX_QUERIES_PER_BATCH),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** One result row: dimension/bucket columns plus one column per requested metric. */
export type ResultRow = Record<string, string | number | null>;

export interface QueryResult {
  rows: ResultRow[];
  /** Present when the request asked for a comparison range. */
  compare?: ResultRow[];
  /** Server-side execution time for this one query. */
  ms?: number;
}

/**
 * A per-query failure inside an otherwise-successful batch: `unsupported` for a
 * combination the vocabulary cannot answer honestly, `not_implemented` for a
 * kind scheduled for a later milestone (sequence queries, docs/08 M2).
 */
export interface QueryErrorResult {
  error: { code: 'unsupported' | 'not_implemented'; message: string };
}

/** Narrows a batch entry (or a compile step's output) to its error shape. */
export function isQueryError(entry: object): entry is QueryErrorResult {
  return 'error' in entry;
}

export interface QueryResponse {
  results: Record<string, QueryResult | QueryErrorResult>;
  meta: { generatedInMs: number; dataVersion: number };
}

// ---------------------------------------------------------------------------
// Admin API (docs/04 § 5) — session auth + CSRF; the settings UI's contract
// ---------------------------------------------------------------------------

/** True when the runtime knows `tz` as an IANA timezone name. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const AdminPasswordSchema = z.string().min(8).max(200);
/** Login takes whatever was typed; only setup/change enforce the strength floor. */
const TypedPasswordSchema = z.string().min(1).max(200);

export const AdminLoginSchema = z.object({ password: TypedPasswordSchema });
export const AdminSetupSchema = z.object({
  password: AdminPasswordSchema,
  /** First-boot token printed to the server log — proof of console access, so a
   * network stranger cannot claim an unconfigured install (docs/04 § 5). */
  setupToken: z.string().min(1).max(128),
});
export const AdminChangePasswordSchema = z.object({
  current: TypedPasswordSchema,
  next: AdminPasswordSchema,
});

const TimezoneSchema = z.string().refine(isValidTimezone, 'not an IANA timezone');
/** Hostname shape (optionally `:port`) — a stored `<script>` or `javascript:` string
 * must be rejected at the boundary, not trusted to render discipline downstream. */
const DomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i, 'not a hostname');

export const AdminSiteCreateSchema = z.object({
  name: z.string().min(1).max(200),
  domains: z.array(DomainSchema).max(20).default([]),
  timezone: TimezoneSchema.optional(),
});
export type AdminSiteCreate = z.infer<typeof AdminSiteCreateSchema>;

export const AdminSitePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    domains: z.array(DomainSchema).max(20).optional(),
    timezone: TimezoneSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'a site patch must change something',
  });
export type AdminSitePatch = z.infer<typeof AdminSitePatchSchema>;

/** `GET /api/admin/me` — the auth bootstrap: which screen the UI should show. */
export interface AdminMe {
  authenticated: boolean;
  /** No password configured yet — the UI may only offer first-run setup. */
  needsSetup: boolean;
  /** Present when authenticated: the token mutations echo as `x-csrf-token`. */
  csrf?: string;
}

/** Login/setup success: the session rides in cookies, the CSRF token in the body. */
export interface AdminSessionGrant {
  ok: true;
  csrf: string;
}

export interface AdminBotDrops {
  siteId: number;
  localDate: string;
  count: number;
}

/** `GET /api/admin/diagnostics` — the settings view's health panel. */
export interface AdminDiagnostics {
  dbSizeBytes: number;
  eventCount: number;
  /** Per site and site-local date, most recent first (last 7 days). */
  botDrops: AdminBotDrops[];
}

// ---------------------------------------------------------------------------
// Widgets & dashboards (docs/05)
// ---------------------------------------------------------------------------

export const VizTypeSchema = z.enum([
  'kpi-row',
  'timeseries',
  'bar-list',
  'table',
  'heatmap',
  'devices',
  'map',
  'feed',
  'site-cards',
]);
export type VizType = z.infer<typeof VizTypeSchema>;

export const WidgetSpecSchema = z.object({
  id: z.string().min(1).max(64),
  viz: VizTypeSchema,
  title: z.string().max(200).optional(),
  /** Grid units: 12-column layout, rows are ~120px bands. */
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(6),
  query: QuerySchema.optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type WidgetSpec = z.infer<typeof WidgetSpecSchema>;

export const DashboardSchema = z.object({
  name: z.string().min(1).max(200),
  site: z.union([z.number().int().positive(), z.literal('all')]),
  grid: z.array(WidgetSpecSchema).max(MAX_WIDGETS_PER_DASHBOARD),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

// ---------------------------------------------------------------------------
// Realtime SSE (docs/04 § 4)
// ---------------------------------------------------------------------------

/** `GET /api/realtime?sites=`: `all` or a comma-separated list of site ids — anything else is a 400. */
export const RealtimeSitesSchema = z.union([
  z.literal('all'),
  z
    .string()
    .regex(/^[1-9]\d*(,[1-9]\d*)*$/)
    .transform((raw) => raw.split(',').map(Number)),
]);

export interface RealtimeHit {
  siteId: number;
  ts: number;
  type: HitType;
  path?: string;
  eventCategory?: string;
  eventAction?: string;
  country?: string;
  city?: string;
  lat?: number;
  lon?: number;
  deviceType?: string;
}

export interface RealtimeSnapshot {
  /** Distinct visitors in the last 5 minutes, by site id. */
  active: Record<number, number>;
  recent: RealtimeHit[];
}

/** Emitted when a site's data changes; dashboards revalidate their query batch. */
export interface VersionTick {
  siteId: number;
  version: number;
}
