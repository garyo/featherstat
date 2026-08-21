import { randomBytes } from 'node:crypto';
import {
  type Hit,
  isHeartbeat,
  type LocalClock,
  localClock,
  PING_CLAMP_MS,
  SESSION_REVIVAL_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import {
  type Db,
  type EventRow,
  type SessionRow,
  type Site,
  selectLatestSession,
  selectOpenSessions,
} from '../db/index.ts';
import { plainNormalizer, type UtmNormalizer } from './campaigns.ts';
import type { DeviceInfo } from './enrich.ts';
import type { GeoResult } from './geo.ts';
import { cleanPageUrl, clickIdSource, synthesizedCampaign } from './page-url.ts';
import { type ReferrerAttribution, referrerAttribution } from './referrers.ts';

export interface SessionizerInput {
  site: Site;
  hit: Hit;
  visitorId: Uint8Array;
  /** Server receive time, UTC ms — the tracker's clock is never trusted (docs/04). */
  now: number;
  device: DeviceInfo;
  geo: GeoResult | null;
  lang: string | null;
  /** Canonical JSON from the prop registry's `admit`, or nothing (docs/03 § Props). */
  props?: string;
}

export interface SessionizedHit {
  event: EventRow;
  /**
   * The live open-session row. The batcher dedupes dirty sessions by row
   * identity, so whatever state this holds at flush time is what lands.
   */
  session: SessionRow;
}

interface OpenSession {
  row: SessionRow;
  /** Running count of stored event rows; the next hit gets `seq + 1`. */
  seq: number;
  /** Flush generation of the last hit — see `noteFlush`. */
  touched: number;
}

/**
 * Cold-path read for session revival: the visitor's most recent session on that
 * site, if it was last seen at or after `notBefore`. Injected rather than held as
 * a `Db` field so the state machine owns no database — the default has no durable
 * store to consult and therefore never revives.
 */
export type PriorSessionLookup = (
  siteId: number,
  visitorId: Uint8Array,
  notBefore: number,
) => RestoredSession | undefined;

/**
 * In-memory session state machine (docs/03): 30 min idle timeout, 1-based `seq`,
 * engagement accrual clamped per gap, first-touch attribution frozen on the
 * session's first hit. Pings update engagement and get stored rows, but never
 * touch pageview or exit-path state.
 *
 * A ping is a *continuation* signal, so it never starts a visit. With no live
 * session it revives the visitor's own last one (the returning-reader window,
 * `SESSION_REVIVAL_MS`); with nothing to revive it is dropped, because a visit
 * with no action in it is not a visit.
 */
export class Sessionizer {
  private readonly open = new Map<string, OpenSession>();
  private lastEvictionAt = 0;
  private dropped = 0;
  private flushes = 0;

  constructor(
    private readonly findPrior: PriorSessionLookup = () => undefined,
    /** Campaign normalization (docs/03 § Campaigns) — the pipeline injects the
     * alias-aware one; the default canonicalizes without an alias table. */
    private readonly normalizeUtm: UtmNormalizer = plainNormalizer,
  ) {}

  get size(): number {
    return this.open.size;
  }

  /** Heartbeats discarded for having no visit to continue — ingest's only other drop is bots. */
  get droppedPings(): number {
    return this.dropped;
  }

  /**
   * The batcher committed a transaction, so every entry touched before now is in
   * the events table. Wired from `onFlush` — the sweep uses it to avoid dropping
   * state the store has not caught up with yet (see `evict`).
   */
  noteFlush(): void {
    this.flushes += 1;
  }

  /** `undefined` when the hit was dropped: an orphan heartbeat, and nothing else. */
  process(input: SessionizerInput): SessionizedHit | undefined {
    const { site, hit, now } = input;
    this.evict(now);
    const key = sessionKey(site.id, input.visitorId);
    const page = pageParts(hit.url);
    const local = localClock(site.timezone, now);

    const carried =
      this.liveSession(key, now) ?? (isHeartbeat(hit.type) ? this.revive(input, key) : undefined);
    if (carried !== undefined) {
      // Clamped per gap, so reviving after half an hour of silence credits one
      // heartbeat's worth of attention, never the silence.
      const gap = now - carried.row.last_seen_at;
      carried.row.engaged_ms += Math.min(Math.max(gap, 0), PING_CLAMP_MS);
      carried.row.last_seen_at = now;
    } else if (isHeartbeat(hit.type)) {
      this.dropped += 1;
      return undefined;
    }
    const state = carried ?? this.begin(input, page, local, key);

    const row = state.row;
    state.seq += 1;
    state.touched = this.flushes;
    if (hit.type === 'pageview') {
      row.pageviews += 1;
      row.exit_path = page.path;
    } else if (hit.type === 'event') {
      row.events += 1;
    }

    const event: EventRow = {
      site_id: site.id,
      ts: now,
      local_date: local.date,
      local_hour: local.hour,
      type: hit.type,
      visitor_id: input.visitorId,
      session_id: row.id,
      seq: state.seq,
      hostname: page.hostname,
      path: page.path,
      title: hit.title ?? null,
      target_url: hit.targetUrl ?? null,
      ref_domain: row.ref_domain,
      ref_domain_raw: row.ref_domain_raw ?? null,
      ref_type: row.ref_type,
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
      utm_source_raw: row.utm_source_raw ?? null,
      utm_medium_raw: row.utm_medium_raw ?? null,
      utm_campaign_raw: row.utm_campaign_raw ?? null,
      event_category: hit.event?.category ?? null,
      event_action: hit.event?.action ?? null,
      event_name: hit.event?.name ?? null,
      event_value: hit.event?.value ?? null,
      browser: input.device.browser,
      browser_version: input.device.browser_version,
      os: input.device.os,
      device_type: input.device.device_type,
      screen: hit.screen ?? null,
      lang: input.lang,
      country: input.geo?.country ?? null,
      region: input.geo?.region ?? null,
      city: input.geo?.city ?? null,
      lat: input.geo?.lat ?? null,
      lon: input.geo?.lon ?? null,
      // `scroll_pct` is optional on EventRow, so nothing here is type-checked:
      // forget this line and the column silently stays null forever.
      scroll_pct: hit.scrollPct ?? null,
      props: input.props ?? null,
    };
    return { event, session: row };
  }

  /**
   * Restart recovery (docs/03): sessions still inside the idle window come back.
   * Deliberately NOT widened to the revival window — the map is the *live* set,
   * and revival reads the durable store on demand instead.
   */
  restore(entries: readonly RestoredSession[]): void {
    for (const entry of entries) {
      this.open.set(sessionKey(entry.row.site_id, entry.row.visitor_id), {
        ...entry,
        touched: this.flushes - 1, // already in the table, by definition
      });
    }
  }

  private liveSession(key: string, now: number): OpenSession | undefined {
    const state = this.open.get(key);
    if (state === undefined) return undefined;
    return now - state.row.last_seen_at > SESSION_TIMEOUT_MS ? undefined : state;
  }

  /**
   * The returning-reader path: the visitor's own last session, reached only by a
   * ping that found no live one.
   *
   * The map is asked first and its answer is final. An entry still held there is
   * the same session the store would return, but with the counters and `seq` of
   * every hit — including any the current batch has not committed yet, which the
   * store cannot see. Falling through to the store is the restart case, and a
   * READ on the ingest path (invariant 2): rare, and served whole by
   * `ix_sessions_open`.
   */
  private revive(input: SessionizerInput, key: string): OpenSession | undefined {
    const notBefore = input.now - SESSION_REVIVAL_MS;
    const held = this.open.get(key);
    if (held !== undefined) return held.row.last_seen_at < notBefore ? undefined : held;
    const prior = this.findPrior(input.site.id, input.visitorId, notBefore);
    if (prior === undefined) return undefined;
    const state: OpenSession = { ...prior, touched: this.flushes - 1 }; // straight from the table
    this.open.set(key, state);
    return state;
  }

  private begin(
    input: SessionizerInput,
    page: PageParts,
    local: LocalClock,
    key: string,
  ): OpenSession {
    const state: OpenSession = {
      ...startSession(input, page, local, this.normalizeUtm),
      touched: this.flushes,
    };
    this.open.set(key, state);
    return state;
  }

  /**
   * Coarse sweep of sessions past the idle timeout, so the map cannot grow
   * without bound (visitor ids rotate daily, so old keys are never reused).
   * A full scan at most once per timeout window is trivial at this scale.
   *
   * An entry whose latest hits are still queued stays one sweep longer: dropping
   * it would leave the store as the only account of the visit, and the store is
   * behind by whatever the current batch holds — a revival would then reuse a
   * `seq` and roll back counters. Retention is unchanged (a committed entry goes
   * at the idle window); past the revival window nothing can be revived anyway,
   * so those go whatever their state.
   */
  private evict(now: number): void {
    if (now - this.lastEvictionAt < SESSION_TIMEOUT_MS) return;
    this.lastEvictionAt = now;
    for (const [key, state] of this.open) {
      const idle = now - state.row.last_seen_at;
      const committed = state.touched < this.flushes;
      if (idle > SESSION_REVIVAL_MS || (idle > SESSION_TIMEOUT_MS && committed)) {
        this.open.delete(key);
      }
    }
  }
}

export interface RestoredSession {
  row: SessionRow;
  /** Highest `seq` already stored for this session. */
  seq: number;
}

export function loadOpenSessions(db: Db, now: number): RestoredSession[] {
  return selectOpenSessions(db, now - SESSION_TIMEOUT_MS).map(({ max_seq, ...row }) => ({
    row,
    seq: max_seq,
  }));
}

/** The database-backed lookup the pipeline hands the sessionizer. */
export function priorSessionLookup(db: Db): PriorSessionLookup {
  return (siteId, visitorId, notBefore) => {
    const found = selectLatestSession(db, siteId, visitorId, notBefore);
    if (found === undefined) return undefined;
    const { max_seq, ...row } = found;
    return { row, seq: max_seq };
  };
}

function sessionKey(siteId: number, visitorId: Uint8Array): string {
  return `${siteId}:${Buffer.from(visitorId).toString('hex')}`;
}

function startSession(
  input: SessionizerInput,
  page: PageParts,
  local: LocalClock,
  normalizeUtm: UtmNormalizer,
): RestoredSession {
  const { site, hit, now } = input;
  const row: SessionRow = {
    id: randomBytes(8),
    site_id: site.id,
    visitor_id: input.visitorId,
    started_at: now,
    last_seen_at: now,
    local_date: local.date,
    local_hour: local.hour,
    entry_path: page.path,
    exit_path: null,
    pageviews: 0,
    events: 0,
    engaged_ms: 0,
    ...classify(hit, page, site, normalizeUtm),
    browser: input.device.browser,
    os: input.device.os,
    device_type: input.device.device_type,
    country: input.geo?.country ?? null,
    region: input.geo?.region ?? null,
    city: input.geo?.city ?? null,
  };
  return { row, seq: 0 };
}

// ---------------------------------------------------------------------------
// Page URL
// ---------------------------------------------------------------------------

interface PageParts {
  hostname: string | null;
  /** pathname + query minus tracking params — the query is page identity, the
   * fragment and tracking identifiers are not (docs/03 § Page identity). */
  path: string | null;
  /** The RAW parsed URL: campaign extraction reads params `path` dropped. */
  url: URL | null;
}

function pageParts(raw: string | undefined): PageParts {
  if (raw === undefined) return { hostname: null, path: null, url: null };
  try {
    const url = new URL(raw);
    return { hostname: url.hostname, path: cleanPageUrl(url), url };
  } catch {
    return { hostname: null, path: raw, url: null };
  }
}

// ---------------------------------------------------------------------------
// Attribution (docs/03): evaluated once per session, on its first hit.
// ---------------------------------------------------------------------------

interface Attribution {
  ref_domain: string | null;
  /** As received, ONLY when canonicalization changed it (docs/03 § Attribution). */
  ref_domain_raw: string | null;
  ref_type: 'direct' | 'search' | 'social' | 'referral' | 'campaign' | 'internal';
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** As received, ONLY when normalization changed it (docs/03 § Campaigns). */
  utm_source_raw: string | null;
  utm_medium_raw: string | null;
  utm_campaign_raw: string | null;
}

type CampaignColumns = Omit<Attribution, 'ref_domain' | 'ref_domain_raw' | 'ref_type'>;

const NO_CAMPAIGN = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_source_raw: null,
  utm_medium_raw: null,
  utm_campaign_raw: null,
};

function classify(hit: Hit, page: PageParts, site: Site, normalizeUtm: UtmNormalizer): Attribution {
  const ref = referrerAttribution(hit.referrer, site.domains);
  const campaign = campaignParams(page.url, site.id, normalizeUtm);
  if (campaign !== null) return { ...refDomain(ref), ref_type: 'campaign', ...campaign };
  // No campaign params, but a click id names its platform: synthesize
  // source/medium the way Matomo/GA treat gclid (docs/03 § Attribution). The
  // click id outranks a referrer too — it is the more specific signal (fbclid
  // usually arrives with NO referrer, from Facebook's in-app browser).
  const clicked = page.url === null ? undefined : clickIdSource(page.url.searchParams);
  if (clicked !== undefined) {
    return {
      ...refDomain(ref),
      ref_type: 'campaign',
      ...synthesizedCampaign(clicked, site.id, normalizeUtm),
    };
  }
  if (ref.ref_type === undefined) {
    return { ref_domain: null, ref_domain_raw: null, ref_type: 'direct', ...NO_CAMPAIGN };
  }
  return { ...refDomain(ref), ref_type: ref.ref_type, ...NO_CAMPAIGN };
}

/** The referrer columns alone: a campaign still records where the click came from. */
function refDomain(ref: ReferrerAttribution): Pick<Attribution, 'ref_domain' | 'ref_domain_raw'> {
  return { ref_domain: ref.ref_domain, ref_domain_raw: ref.ref_domain_raw };
}

/** utm_* / mtm_* / pk_* families all accepted, stored under the utm_ columns (docs/03). */
const CAMPAIGN_FAMILIES = ['utm', 'mtm', 'pk'] as const;

function campaignParams(
  url: URL | null,
  siteId: number,
  normalizeUtm: UtmNormalizer,
): CampaignColumns | null {
  if (url === null) return null;
  const get = (field: string): string | null => {
    for (const family of CAMPAIGN_FAMILIES) {
      const value = url.searchParams.get(`${family}_${field}`);
      if (value) return value.slice(0, 200);
    }
    return null;
  };
  const source = get('source');
  const medium = get('medium');
  const campaign = get('campaign');
  if (source === null && medium === null && campaign === null) return null;
  // Normalized at ingest, raw kept only when it differs (docs/03 § Campaigns).
  const norm = (field: 'source' | 'medium' | 'campaign', value: string | null) =>
    value === null ? { normalized: null } : normalizeUtm(siteId, field, value);
  const s = norm('source', source);
  const m = norm('medium', medium);
  const c = norm('campaign', campaign);
  return {
    utm_source: s.normalized,
    utm_medium: m.normalized,
    utm_campaign: c.normalized,
    utm_source_raw: s.raw ?? null,
    utm_medium_raw: m.raw ?? null,
    utm_campaign_raw: c.raw ?? null,
  };
}
