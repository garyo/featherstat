import { z } from 'zod';
import type { RealtimeVisitor } from './alias.ts';
import { DerivedMetricRefSchema } from './derived.ts';
import {
  type Dimension,
  DimensionSchema,
  FiltersSchema,
  PROP_KEY_PATTERN,
  type SegmentFilterNode,
  SegmentFilterNodeSchema,
} from './filters.ts';
import { GoalMetricRefSchema } from './goals.ts';
import type { Measures } from './measures.ts';

// ---------------------------------------------------------------------------
// Constants (docs/03)
// ---------------------------------------------------------------------------

/** One day of UTC milliseconds — date arithmetic everywhere is plain UTC-ms math. */
export const DAY_MS = 86_400_000;
export const SESSION_TIMEOUT_MS = 30 * 60_000;
/**
 * The returning-reader window (docs/03 § Sessionization): how far back a heartbeat
 * may reach to revive the visitor's own last session instead of opening a new one.
 * A ping is a continuation signal, so the reader who leaves a tab open over lunch
 * and comes back is continuing a visit, not starting one; past this they are
 * arriving. `visitor_id` rotates at 00:00 UTC, so the effective reach is always
 * `min(this, time since the last UTC midnight)`.
 */
export const SESSION_REVIVAL_MS = 4 * 60 * 60_000;
/** A session with less engaged time than this (and 1 pageview, no events) is a bounce. */
export const ENGAGEMENT_THRESHOLD_MS = 15_000;
/** Max gap credited to engaged time per ping/event (heartbeat interval + slack). */
export const PING_CLAMP_MS = 20_000;
export const BATCH_INTERVAL_MS = 200;
export const MAX_QUERIES_PER_BATCH = 32;
export const MAX_WIDGETS_PER_DASHBOARD = 24;
/** Metrics one query may name (docs/04 § 3) — also the ceiling a layout upgrade must respect. */
export const MAX_METRICS_PER_QUERY = 8;
/**
 * Bucket keys a single result's axis may enumerate (docs/04 § 3). Every preset
 * stays far under it — 90 days of days, a day of hours — but an explicit
 * `from`/`to` range at `hour` granularity does not, and the axis rides in the
 * response body of a public share link. Past this the axis is omitted and the
 * rows' own order is the axis.
 */
export const MAX_AXIS_KEYS = 1_000;

// Realtime SSE wire contract (docs/04 § 4)
/** "Active" = distinct visitors seen inside this window. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Cadence of the `active` recount event. */
export const ACTIVE_TICK_MS = 10_000;
/** Cadence of the keep-alive comment that stops proxies reaping the stream. */
export const HEARTBEAT_MS = 25_000;
/**
 * Hits a fresh connection's `snapshot` is seeded with. Raw hits, so pings count
 * against it: after the client collapses each page's run into one line, 200 of
 * these is a feed of far fewer rows than the number suggests.
 */
export const SNAPSHOT_HITS = 200;
/**
 * Window the realtime view's per-visitor tally covers — and how long the hub
 * retains a visitor's engaged time.
 *
 * It matches how far back the feed itself reaches, and that is the whole point:
 * a tally that expired sooner than the rows left most of the list unanswerable,
 * with visitors on screen whose engagement had already been forgotten. The two
 * are the same information — by visitor, and by visitor-and-page — so they
 * cover the same span or one of them is furniture.
 */
export const TALLY_WINDOW_MS = 8 * 3_600_000;
/**
 * How that window reads in a title. Derived, because it was written out by hand
 * in two widgets and became wrong the moment the number moved.
 */
export const TALLY_WINDOW_LABEL = `last ${TALLY_WINDOW_MS / 3_600_000}h`;
/**
 * Bound on the live engagement map (and so on the frame that ships it): a busy
 * half hour must not grow either without limit. Newest visitors win.
 */
export const MAX_ENGAGEMENT_ENTRIES = 200;

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

// ---------------------------------------------------------------------------
// Custom props (docs/03 § Props) — native tracker only; the Matomo shim never
// produces them. Caps are enforced server-side in pipeline/props.ts; breaches
// clamp and count in prop_drops, never bounce the beacon (invariant 4).
// ---------------------------------------------------------------------------

/** Props one event may carry; extras past this are dropped in sorted key order. */
export const PROPS_PER_EVENT = 10;
/** Canonical-JSON byte ceiling for one event's bag; past it the bag is dropped whole. */
export const PROP_BAG_MAX_BYTES = 1024;
/** Distinct keys one site may accumulate; new keys past this are dropped. */
export const PROP_KEYS_PER_SITE = 30;
/** Distinct values one key may accumulate; new values past this clamp to the sentinel. */
export const PROP_VALUES_PER_KEY = 500;
/** What a value clamped by the per-key cardinality cap is stored as. */
export const PROP_VALUE_OTHER = '(other)';

/** One event's prop bag as validated at the boundary; the registry caps the rest. */
export const PropsSchema = z.record(
  z.string().regex(PROP_KEY_PATTERN),
  z.union([z.string().max(200), z.number().finite(), z.boolean()]),
);
export type Props = z.infer<typeof PropsSchema>;

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
  /**
   * How far down the page the reader had got when this hit was sent, 0–100
   * (docs/04 § 2). Rides pings, because the heartbeat is what re-measures a
   * page; absent means unmeasured, which is not the same as 0.
   */
  scrollPct: z.number().int().min(0).max(100).optional(),
  /** Custom props, native tracker only (docs/03 § Props). Post-parse boundary:
   * no catch here — the collect parser already degraded a malformed bag. */
  props: PropsSchema.optional(),
});
export type Hit = z.infer<typeof HitSchema>;

/**
 * One hit as the native tracker puts it on the wire (docs/04 § 2). Flatter than
 * `Hit`: the event fields ride at the top level because the tracker builds this
 * by hand and `JSON.stringify` drops the absent ones — `ingest/native.ts` lifts
 * them into `Hit.event`. Every optional field degrades on its own rather than
 * failing the hit, so an over-long title costs the title, not the page view.
 */
export const CollectHitSchema = z.object({
  type: HitTypeSchema,
  url: z.string().max(2048).optional().catch(undefined),
  title: z.string().max(512).optional().catch(undefined),
  referrer: z.string().max(2048).optional().catch(undefined),
  targetUrl: z.string().max(2048).optional().catch(undefined),
  category: z.string().min(1).max(200).optional().catch(undefined),
  action: z.string().min(1).max(200).optional().catch(undefined),
  name: z.string().max(500).optional().catch(undefined),
  value: z.number().optional().catch(undefined),
  screen: z.string().max(20).optional().catch(undefined),
  lang: z.string().max(35).optional().catch(undefined),
  scroll: z.number().int().min(0).max(100).optional().catch(undefined),
  /** A malformed bag costs the bag, never the hit (invariant 4). */
  props: PropsSchema.optional().catch(undefined),
});
export type CollectHit = z.infer<typeof CollectHitSchema>;

/**
 * A page of beacons is the honest size of a collect body; past this the extra
 * hits are dropped and the rest still recorded, because a beacon never bounces
 * (CLAUDE.md invariant 4).
 */
export const MAX_COLLECT_HITS = 50;

/**
 * The collect envelope. Deliberately loose about `hits`: each one is validated
 * separately by the parser, so one malformed entry costs itself and not the
 * batch it travelled in.
 */
export const CollectRequestSchema = z.object({
  site: z.number().int().positive(),
  hits: z.array(z.unknown()),
});

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
  'outlinks',
  'downloads',
  'engaged_ms',
  'engaged_sessions',
  'avg_engagement',
  'bounce_rate',
  'views_per_visit',
  'event_value_sum',
]);
export type Metric = z.infer<typeof MetricSchema>;

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
  'target_url',
  'screen',
  'lang',
  'event_category',
  'event_action',
  'event_name',
  'local_hour',
] as const satisfies readonly Dimension[];

/**
 * Dimensions only the sessions table carries — `EVENT_ONLY_DIMENSIONS`' mirror.
 * Grouping or hit-scope filtering by one makes event-level metrics unanswerable;
 * a `scope: 'session'` filter leaf never conflicts (it names a session attribute).
 */
export const SESSION_ONLY_DIMENSIONS = [
  'entry_path',
  'exit_path',
] as const satisfies readonly Dimension[];

/** Metrics only the sessions table can answer — unavailable under `EVENT_ONLY_DIMENSIONS`. */
export const SESSION_ONLY_METRICS = [
  'engaged_ms',
  'engaged_sessions',
  'avg_engagement',
  'bounce_rate',
  'views_per_visit',
] as const satisfies readonly Metric[];

/** Metrics only the events table can answer — unavailable under `SESSION_ONLY_DIMENSIONS`. */
export const EVENT_ONLY_METRICS = [
  'visitors',
  'pageviews',
  'events',
  'outlinks',
  'downloads',
  'event_value_sum',
] as const satisfies readonly Metric[];

export const MetricQuerySchema = z.object({
  id: z.string().min(1).max(64),
  /** Built-in metrics plus `d:<name>` references to stored derived metrics and
   * `goal:<id>:<aspect>` goal metrics (docs/04 § 3). The cap counts what was
   * ASKED for; a derived metric's components ride under a separate internal
   * ceiling in the executor. */
  metrics: z
    .array(z.union([MetricSchema, DerivedMetricRefSchema, GoalMetricRefSchema]))
    .min(1)
    .max(MAX_METRICS_PER_QUERY),
  dim: DimensionSchema.optional(),
  dim2: DimensionSchema.optional(),
  bucket: BucketSchema.optional(),
  filters: FiltersSchema.optional(),
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

/**
 * Time on page (docs/03 § Sessionization, docs/04 § 3): per-page dwell over the
 * session-scoped envelope. Every event — pings included — credits the gap to the
 * next event, clamped at `PING_CLAMP_MS`, to the pageview it followed. Nothing to
 * pick but the ranking depth: the shape is the answer.
 */
export const DwellQuerySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('dwell'),
  /** Restricts the per-page legs to this page — a leg selection, not a session filter. */
  path: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).default(10),
});
export type DwellQuery = z.infer<typeof DwellQuerySchema>;

/**
 * Page adjacency (docs/03 § Journeys, docs/04 § 3): what came just before —
 * or just after — one page, anywhere in each session in scope. Rows are
 * `{ label, sessions }` counting DISTINCT sessions containing the adjacency;
 * `(entry)` / `(exit)` are the pseudo-rows for sessions that start or end at
 * the page. The same run-collapse as the sequence kinds: a repeat is not a move.
 */
export const AdjacencyQuerySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('adjacency'),
  path: z.string().min(1).max(2048),
  direction: z.enum(['in', 'out']),
  limit: z.number().int().min(1).max(100).default(10),
});
export type AdjacencyQuery = z.infer<typeof AdjacencyQuerySchema>;

/**
 * Fixed-bucket histograms over the same page legs `dwell` times (docs/04 § 3):
 * dwell milliseconds into coarse duration bands, or measured scroll depth into
 * deciles. Rows are `{ bucket, legs }`, sparse — an empty bucket is omitted.
 * Scroll counts only MEASURED legs: unmeasured is never 0 (the honesty rule).
 */
export const DistributionQuerySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('distribution'),
  of: z.enum(['dwell', 'scroll']),
  /** Restricts the legs to one page, like `dwell.path`. */
  path: z.string().min(1).max(2048).optional(),
});
export type DistributionQuery = z.infer<typeof DistributionQuerySchema>;

export const QuerySchema = z.union([
  SequenceQuerySchema,
  DwellQuerySchema,
  AdjacencyQuerySchema,
  DistributionQuerySchema,
  MetricQuerySchema,
]);
export type Query = z.infer<typeof QuerySchema>;

/** A real calendar date — the regex alone admits impossible months and days. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const ms = Date.parse(`${date}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(date);
  }, 'not a calendar date');

/**
 * The range vocabulary (docs/04 § 3). `24h` is the one ROLLING preset: the 24
 * hour buckets ending with the one in progress, which is why it alone resolves
 * to edges inside a local date. The rest are whole local dates, and `today` and
 * `mtd` are partial — their compare period is the complete one before, as every
 * calendar-range analytics product reads it.
 */
export const RangePresetSchema = z.enum(['today', '24h', '7d', '30d', '90d', 'mtd']);
export type RangePreset = z.infer<typeof RangePresetSchema>;

export const RangeSchema = z.union([
  z.object({ preset: RangePresetSchema }),
  z.object({ from: isoDate, to: isoDate }),
]);
export type Range = z.infer<typeof RangeSchema>;

/**
 * The comparison vocabulary (docs/04 § 3). The two string forms are v1's,
 * unchanged. `{segment}` compares the same window against the same window
 * seen through a saved segment's filter; `{from, to}` compares against an
 * explicit window, used as given — when its length differs from the current
 * window the rows still align by index from the start, and `meta.windows`
 * labels the mismatch with `compareFrom`/`compareTo`.
 */
export const CompareSchema = z.union([
  z.enum(['previous', 'year']),
  z.object({ segment: z.number().int().positive() }),
  z.object({ from: isoDate, to: isoDate }),
]);
export type Compare = z.infer<typeof CompareSchema>;

export const QueryRequestSchema = z.object({
  site: z.union([z.number().int().positive(), z.literal('all')]),
  range: RangeSchema,
  compare: CompareSchema.optional(),
  filters: FiltersSchema.optional(),
  queries: z.array(QuerySchema).min(1).max(MAX_QUERIES_PER_BATCH),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** One result row: dimension/bucket columns plus one column per requested metric.
 * Flows rows (sequence queries) carry their step signature as a string array. */
export type ResultRow = Record<string, string | number | null | string[]>;

/**
 * One site's resolved query window: the inclusive site-local date bounds a
 * `range` resolved to, and the timezone it resolved in (docs/04 § 3).
 *
 * A response carries one per site in scope, never one per response: `site: "all"`
 * fans out across sites whose timezones differ, so around a local midnight there
 * is no single window that describes the batch. The same array is hashed into the
 * ETag, which is why a `today` preset expires at site-local midnight.
 */
export interface SiteWindow {
  siteId: number;
  timezone: string;
  from: string;
  to: string;
  /**
   * A half-open `[fromTs, toTs)` refinement in UTC ms, present only for a window
   * whose edges fall INSIDE a local date — today, only the rolling `24h` preset.
   * The dates above still bound it (they are the dates this span touches, which
   * is what keeps the indexed `local_date` comparison doing the index work); the
   * instants trim it to the hour.
   *
   * Both are quantized to a local hour boundary, so the window is stable within
   * an hour and rolls as the hour turns. That is what lets the ETag hash it: an
   * edge that followed the clock would mint a new tag on every request.
   */
  fromTs?: number;
  toTs?: number;
  /**
   * Present exactly when the request's `compare` was an explicit `{from, to}`:
   * the window the compare rows were computed on, restated per site because the
   * preset forms derive theirs per window and this form does not. It is the
   * label for an unequal-length comparison — rows align by index from the
   * start, and these dates are what makes that mismatch visible instead of
   * silent (docs/04 § 3).
   */
  compareFrom?: string;
  compareTo?: string;
}

/**
 * One site's time axis for a bucketed result — the ordered bucket keys sparse
 * rows are zipped against, so no client ever enumerates buckets.
 */
export interface SiteAxis {
  siteId: number;
  /**
   * Every bucket key this site's window contains, oldest first. A pure function
   * of the window and the granularity — never of the clock — so a cached body
   * replayed on a 304 can never have gone stale.
   */
  keys: string[];
  /**
   * Where real data stops inside the window: the newest key whose bucket had
   * BEGUN on the server's clock when the response was generated. Keys after it
   * are future time — `today` resolves to a whole local day, so its hour axis
   * runs to 23:00 while only the hours through `clip` can hold anything.
   *
   * Absent when the whole window is still in the future (an explicit
   * `from`/`to` range ahead of now). A reader whose clock has moved on since the
   * fetch may show MORE than this, never less (see the web app's `visibleKeys`).
   */
  clip?: string;
}

export interface QueryResult {
  rows: ResultRow[];
  /** Present when the request asked for a comparison range. */
  compare?: ResultRow[];
  /** Server-side execution time for this one query. */
  ms?: number;
  /** The granularity this result was grouped at; absent when it isn't bucketed. */
  bucket?: Bucket;
  /**
   * The enumerated time axis, one entry per site in `meta.windows`.
   *
   * Rows stay SPARSE — this is the key list to zip them against, not a promise
   * that every key has a row. Emitted only when `bucket` is the result's one
   * grouping besides `site` (which the axis is already keyed by): a genuine 2-D
   * result like `path × day` is deliberately unlimited, so an axis there would
   * invite a dense fill of tens of thousands of manufactured rows — down a code
   * path a client-authored layout reaches through a public share link.
   *
   * Also absent when the window would enumerate more than `MAX_AXIS_KEYS`; the
   * rows' own order is then the axis.
   */
  axis?: SiteAxis[];
  /**
   * What each metric column of these rows counts, and how it may be recombined
   * (docs/04 § 3) — declared once per RESULT, never per value, so a 1000-row
   * breakdown does not carry 1000 copies of its own schema.
   *
   * The `aggregate` is what makes a client's re-aggregation legal by
   * construction: a chart reducing 90 daily points into 12 slices has to
   * recombine them, and only the server knows whether that is a sum, a
   * re-division, or a thing with no total at all (see `measureTotal`).
   *
   * Absent only for a kind with no measures to declare — the sequence queries,
   * whose columns are a step signature and the sessions that walked it.
   */
  measures?: Measures;
}

/**
 * A per-query failure inside an otherwise-successful batch: `unsupported` for a
 * combination the vocabulary cannot answer honestly, `not_implemented` for a
 * kind scheduled for a later milestone.
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
  meta: {
    generatedInMs: number;
    dataVersion: number;
    /** What the server resolved this request's `range` to, per site in scope. */
    windows: SiteWindow[];
  };
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
  /** Present when authenticated: which kind of session this is, so the SPA
   * can hide the admin surface from a viewer instead of 403-ing into it. */
  principal?: 'admin' | 'viewer';
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
// Props governance (docs/03 § Props, docs/04 § 5) — the admin surface's contract
// ---------------------------------------------------------------------------

/** One `prop_keys` row as the settings view reads it. */
export const AdminPropKeySchema = z.object({
  key: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  /** Stored event rows carrying this key. */
  events: z.number(),
  distinctValues: z.number(),
  /** Set when the per-key value-cardinality clamp engaged; null while under cap. */
  overCapSince: z.number().nullable(),
});
export type AdminPropKey = z.infer<typeof AdminPropKeySchema>;

/** One recent `prop_drops` counter — the diagnostics mirror of bot drops. */
export const AdminPropDropSchema = z.object({
  localDate: z.string(),
  reason: z.string(),
  count: z.number(),
});
export type AdminPropDrop = z.infer<typeof AdminPropDropSchema>;

/** `GET /api/admin/props?site=<id>` */
export const AdminPropsResponseSchema = z.object({
  keys: z.array(AdminPropKeySchema),
  drops: z.array(AdminPropDropSchema),
});
export type AdminPropsResponse = z.infer<typeof AdminPropsResponseSchema>;

// ---------------------------------------------------------------------------
// API tokens (docs/04 § 5) — scoped read-only principals for scripts/MCP
// ---------------------------------------------------------------------------

export const ApiTokenCreateSchema = z.object({
  name: z.string().min(1).max(64),
  /** `'all'` or an explicit site-id list — never empty: a token that can read
   * nothing is a mistake, not a configuration. */
  sites: z.union([z.literal('all'), z.array(z.number().int().positive()).min(1).max(100)]),
});
export type ApiTokenCreate = z.infer<typeof ApiTokenCreateSchema>;

/** The listing shape; the raw token appears only in the mint response. */
export interface ApiTokenInfo {
  id: number;
  name: string;
  sites: 'all' | number[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** `POST /api/admin/tokens` — `token` is shown once and never retrievable. */
export interface ApiTokenMinted extends ApiTokenInfo {
  token: string;
}

// ---------------------------------------------------------------------------
// Viewers (docs/04 § 5) — invited read-only principals, claimed by magic link
// ---------------------------------------------------------------------------

export const ViewerInviteSchema = z.object({
  email: z.email().max(254),
  /** `'all'` or an explicit site-id list — never empty, like a token's scope. */
  sites: z.union([z.literal('all'), z.array(z.number().int().positive()).min(1).max(100)]),
});
export type ViewerInvite = z.infer<typeof ViewerInviteSchema>;

/** `GET /api/admin/viewers` row. */
export interface ViewerInfo {
  id: number;
  email: string;
  sites: 'all' | number[];
  createdAt: number;
  revokedAt: number | null;
}

/** Mint response: `url` is the single-use claim path, shown exactly once —
 * the admin copies it out of band (no SMTP; see `deliverInvite`). */
export interface MagicLinkMinted {
  viewerId: number;
  /** Relative claim path (`/invite/<token>`); prefix with the instance origin. */
  url: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Saved segments (docs/04 § 3) — named filter trees, expanded server-side
// ---------------------------------------------------------------------------

/**
 * What a stored segment is: a name and ONE `SegmentFilterNode` — the filter
 * grammar without segment refs, so a segment can never reference a segment
 * and cycles are impossible by construction (docs/04 § 3).
 */
export const SegmentCreateSchema = z.object({
  name: z.string().min(1).max(64),
  filter: SegmentFilterNodeSchema,
});
export type SegmentCreate = z.infer<typeof SegmentCreateSchema>;

/** `GET /api/segments` row — everything a client needs to offer the segment. */
export interface SegmentInfo {
  id: number;
  name: string;
  filter: SegmentFilterNode;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// ntfy notifications (docs/01 R16) — configured through the settings table
// ---------------------------------------------------------------------------

/** Loopback is exempt from the https floor: nothing there reaches a wire. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Hosts the server must never POST a bearer token to: the link-local range is
 * cloud metadata services (169.254.169.254 and friends), which no ntfy server
 * legitimately lives on. Private RFC-1918 ranges stay ALLOWED — a self-hosted
 * ntfy on the operator's LAN is a first-class deployment, and the URL is set
 * only through the authenticated admin API (docs/02 § Security posture).
 */
const LINK_LOCAL_V4 = /^169\.254\./;
const LINK_LOCAL_V6 = /^\[fe[89ab][0-9a-f]:/i;
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/** The notification endpoint may carry a bearer token: https, or http to loopback. */
export function isSecureWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (LINK_LOCAL_V4.test(host) || LINK_LOCAL_V6.test(host) || METADATA_HOSTS.has(host)) {
    return false;
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(host));
}

export const NtfyUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isSecureWebhookUrl, 'must be an https URL (http only for loopback)')
  // `<url>/<topic>` appends a path segment; a query or fragment would swallow it.
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return url.search === '' && url.hash === '';
    } catch {
      return true; // unparseable already failed the refinement above
    }
  }, 'must not contain a query string or fragment');

/** ntfy's own topic charset — also what keeps `<url>/<topic>` one path segment. */
export const NtfyTopicSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not an ntfy topic');

export const MAX_NTFY_RULES = 50;

/**
 * One notification rule: a hit matching **every** field present here fires it.
 * `label` is the event name (Matomo `e_n`). A rule that constrains nothing
 * would fire on every hit of every site — that is a mistake, not a feature.
 */
export const NtfyRuleSchema = z
  .object({
    site: z.number().int().positive().optional(),
    eventCategory: z.string().min(1).max(200).optional(),
    eventAction: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(500).optional(),
  })
  .refine((rule) => Object.values(rule).some((value) => value !== undefined), {
    message: 'a rule must constrain something',
  });
export type NtfyRule = z.infer<typeof NtfyRuleSchema>;

/** Shape of the `ntfy_rules` settings row. */
export const NtfyRulesSchema = z.array(NtfyRuleSchema).max(MAX_NTFY_RULES);

/** `PUT /api/admin/ntfy` — a full replacement, except the write-only token. */
export const NtfySettingsSchema = z.object({
  url: NtfyUrlSchema,
  topic: NtfyTopicSchema,
  /** Omitted keeps the stored token (the GET never echoes it); null or '' clears it. */
  token: z.string().max(500).nullable().optional(),
  rules: NtfyRulesSchema.default([]),
});
export type NtfySettingsInput = z.infer<typeof NtfySettingsSchema>;

/** `GET /api/admin/ntfy` — a secret is never sent back, only its presence. */
export interface NtfySettingsView {
  url?: string;
  topic?: string;
  tokenSet: boolean;
  rules: NtfyRule[];
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
  'dwell',
  'map',
  'feed',
  'active-now',
  'visitor-tally',
  'realtime-countries',
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
  /**
   * Which metric vocabulary this document was written against (docs/05 § Layout
   * versions). A stored layout is a query plan the server executes long after it
   * was authored, so it states which plan it is and `upgradeDashboard` carries
   * it forward on read.
   *
   * Absent — every row written before versioning — and anything unreadable both
   * read as `OLDEST_DASHBOARD_LAYOUT_VERSION` (spelled literally so the schema
   * imports nothing). Reading low costs one idempotent upgrade pass; reading
   * high would keep a stale plan forever, and refusing the row outright would
   * strand a dashboard nobody can repair.
   */
  version: z.number().int().min(1).catch(1),
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

/**
 * One hit, as it happened. The feed is the raw stream now — pings included —
 * and a row carries no derived figure at all.
 *
 * That absence is the design. A row used to carry "how long the visit had been
 * going when this landed", which could not be summed (4 s, 6 s and 8 s under a
 * tally of 54 s read as a contradiction) and which the boot path could not
 * reconstruct, so it silently substituted the visit's TOTAL and a row meant one
 * thing live and another after a restart. With nothing derived on the wire,
 * seeding from storage is the same rows as the live path and cannot drift.
 *
 * Time on page is recovered by collapsing consecutive hits on one page
 * (`lib/realtime.ts`), where it is the span of the run — the same clamped-gap
 * attribution `query/dwell.ts` makes, so the feed and the time-on-page card
 * cannot disagree.
 */
export interface RealtimeHit {
  siteId: number;
  ts: number;
  type: HitType;
  /** Ephemeral per-UTC-day alias — never the visitor id itself (see ./alias.ts). */
  visitor: RealtimeVisitor;
  path?: string;
  eventCategory?: string;
  eventAction?: string;
  country?: string;
  /** ISO 3166-2 subdivision code, unprefixed — the feed prints it for US/CA. */
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  deviceType?: string;
}

/**
 * One visitor's engaged time inside `TALLY_WINDOW_MS`, keyed by the same per-day
 * alias its hits wear — the visitor id itself never reaches the wire (docs/03 §
 * Visitor identity). `engagedMs` covers the CURRENT session only: a gap past the
 * session timeout starts it over, so the figure reads as time on site.
 */
export interface RealtimeEngagement {
  /** Same opaque handle the hits carry — what the client joins on. */
  ref: string;
  name: string;
  color: number;
  siteId: number;
  engagedMs: number;
  /** Last event (ping included) from this visitor — what ages the entry out. */
  lastTs: number;
}

export interface RealtimeSnapshot {
  /** Distinct visitors in the last 5 minutes, by site id. */
  active: Record<number, number>;
  recent: RealtimeHit[];
  /** Engaged time per visitor seen in the last 30 minutes. */
  visitors: RealtimeEngagement[];
}

/** The 10 s `active` recount: the counts every view shows, plus per-visitor engaged time. */
export interface RealtimeActive {
  active: Record<number, number>;
  visitors: RealtimeEngagement[];
}

/** Emitted when a site's data changes; dashboards revalidate their query batch. */
export interface VersionTick {
  siteId: number;
  version: number;
}

export * from './alias.ts';
export * from './campaigns.ts';
export * from './csv.ts';
export * from './derived.ts';
export * from './filters.ts';
export * from './goals.ts';
export * from './layout.ts';
export * from './measures.ts';
export * from './time.ts';
export * from './widgets.ts';
