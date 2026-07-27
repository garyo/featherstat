import { randomBytes } from 'node:crypto';
import { type Hit, PING_CLAMP_MS, SESSION_TIMEOUT_MS } from '@analytics/shared';
import {
  type Db,
  type EventRow,
  type SessionRow,
  type Site,
  selectOpenSessions,
} from '../db/index.ts';
import type { DeviceInfo } from './enrich.ts';
import type { GeoResult } from './geo.ts';

export interface SessionizerInput {
  site: Site;
  hit: Hit;
  visitorId: Uint8Array;
  /** Server receive time, UTC ms — the tracker's clock is never trusted (docs/04). */
  now: number;
  device: DeviceInfo;
  geo: GeoResult | null;
  lang: string | null;
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
}

/**
 * In-memory session state machine (docs/03): 30 min idle timeout, 1-based `seq`,
 * engagement accrual clamped per gap, first-touch attribution frozen on the
 * session's first hit. Pings update engagement and get stored rows, but never
 * touch pageview or exit-path state.
 */
export class Sessionizer {
  private readonly open = new Map<string, OpenSession>();
  private lastEvictionAt = 0;

  get size(): number {
    return this.open.size;
  }

  process(input: SessionizerInput): SessionizedHit {
    const { site, hit, now } = input;
    this.evict(now);
    const key = sessionKey(site.id, input.visitorId);
    const page = pageParts(hit.url);
    const local = localParts(site.timezone, now);

    let state = this.open.get(key);
    if (state === undefined || now - state.row.last_seen_at > SESSION_TIMEOUT_MS) {
      state = startSession(input, page, local.date);
      this.open.set(key, state);
    } else {
      const gap = now - state.row.last_seen_at;
      state.row.engaged_ms += Math.min(Math.max(gap, 0), PING_CLAMP_MS);
      state.row.last_seen_at = now;
    }

    const row = state.row;
    state.seq += 1;
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
      ref_type: row.ref_type,
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
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
    };
    return { event, session: row };
  }

  /** Restart recovery (docs/03): sessions still inside the idle window come back. */
  restore(entries: readonly RestoredSession[]): void {
    for (const entry of entries) {
      this.open.set(sessionKey(entry.row.site_id, entry.row.visitor_id), { ...entry });
    }
  }

  /**
   * Coarse sweep of sessions past the idle timeout, so the map cannot grow
   * without bound (visitor ids rotate daily, so old keys are never reused).
   * A full scan at most once per timeout window is trivial at this scale.
   */
  private evict(now: number): void {
    if (now - this.lastEvictionAt < SESSION_TIMEOUT_MS) return;
    this.lastEvictionAt = now;
    for (const [key, state] of this.open) {
      if (now - state.row.last_seen_at > SESSION_TIMEOUT_MS) this.open.delete(key);
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

function sessionKey(siteId: number, visitorId: Uint8Array): string {
  return `${siteId}:${Buffer.from(visitorId).toString('hex')}`;
}

function startSession(input: SessionizerInput, page: PageParts, localDate: string): OpenSession {
  const { site, hit, now } = input;
  const row: SessionRow = {
    id: randomBytes(8),
    site_id: site.id,
    visitor_id: input.visitorId,
    started_at: now,
    last_seen_at: now,
    local_date: localDate,
    entry_path: page.path,
    exit_path: null,
    pageviews: 0,
    events: 0,
    engaged_ms: 0,
    ...classify(hit, page, site),
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
  /** pathname + query — the query is page identity, the fragment is not (docs/04). */
  path: string | null;
  url: URL | null;
}

function pageParts(raw: string | undefined): PageParts {
  if (raw === undefined) return { hostname: null, path: null, url: null };
  try {
    const url = new URL(raw);
    return { hostname: url.hostname, path: url.pathname + url.search, url };
  } catch {
    return { hostname: null, path: raw, url: null };
  }
}

// ---------------------------------------------------------------------------
// Attribution (docs/03): evaluated once per session, on its first hit.
// ---------------------------------------------------------------------------

interface Attribution {
  ref_domain: string | null;
  ref_type: 'direct' | 'search' | 'social' | 'referral' | 'campaign' | 'internal';
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

const NO_CAMPAIGN = { utm_source: null, utm_medium: null, utm_campaign: null };

function classify(hit: Hit, page: PageParts, site: Site): Attribution {
  const host = referrerHost(hit.referrer);
  const campaign = campaignParams(page.url);
  if (campaign !== null) return { ref_domain: host, ref_type: 'campaign', ...campaign };
  if (host === null) return { ref_domain: null, ref_type: 'direct', ...NO_CAMPAIGN };
  if (isInternal(host, site.domains))
    return { ref_domain: host, ref_type: 'internal', ...NO_CAMPAIGN };
  return { ref_domain: host, ref_type: knownReferrerType(host) ?? 'referral', ...NO_CAMPAIGN };
}

/** utm_* / mtm_* / pk_* families all accepted, stored under the utm_ columns (docs/03). */
const CAMPAIGN_FAMILIES = ['utm', 'mtm', 'pk'] as const;

function campaignParams(url: URL | null): Omit<Attribution, 'ref_domain' | 'ref_type'> | null {
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
  return { utm_source: source, utm_medium: medium, utm_campaign: campaign };
}

function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return stripWww(new URL(referrer).hostname.toLowerCase());
  } catch {
    return null;
  }
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function isInternal(host: string, domains: readonly string[]): boolean {
  return domains.some((entry) => {
    const domain = stripWww(entry.toLowerCase());
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Small built-in search/social table (docs/03): the long tail is not worth a database. */
const KNOWN_REFERRERS: Record<string, 'search' | 'social'> = {
  // search
  'google.com': 'search',
  'google.co.uk': 'search',
  'google.de': 'search',
  'google.fr': 'search',
  'google.es': 'search',
  'google.it': 'search',
  'google.nl': 'search',
  'google.ca': 'search',
  'google.com.au': 'search',
  'google.com.br': 'search',
  'google.co.in': 'search',
  'google.co.jp': 'search',
  'bing.com': 'search',
  'duckduckgo.com': 'search',
  'yahoo.com': 'search',
  'baidu.com': 'search',
  'yandex.com': 'search',
  'yandex.ru': 'search',
  'ecosia.org': 'search',
  'qwant.com': 'search',
  'brave.com': 'search',
  'startpage.com': 'search',
  'kagi.com': 'search',
  'ask.com': 'search',
  'aol.com': 'search',
  'naver.com': 'search',
  'seznam.cz': 'search',
  // social
  'facebook.com': 'social',
  'fb.com': 'social',
  'twitter.com': 'social',
  'x.com': 'social',
  't.co': 'social',
  'instagram.com': 'social',
  'threads.net': 'social',
  'linkedin.com': 'social',
  'lnkd.in': 'social',
  'reddit.com': 'social',
  'pinterest.com': 'social',
  'tiktok.com': 'social',
  'youtube.com': 'social',
  'youtu.be': 'social',
  'news.ycombinator.com': 'social',
  'mastodon.social': 'social',
  'bsky.app': 'social',
  'discord.com': 'social',
  'discord.gg': 'social',
  't.me': 'social',
  'telegram.org': 'social',
  'whatsapp.com': 'social',
  'snapchat.com': 'social',
  'tumblr.com': 'social',
  'vk.com': 'social',
  'weibo.com': 'social',
};

/** Walks host suffixes so `l.facebook.com` matches the `facebook.com` entry. */
function knownReferrerType(host: string): 'search' | 'social' | undefined {
  for (let h = host; ; ) {
    const type = KNOWN_REFERRERS[h];
    if (type !== undefined) return type;
    const dot = h.indexOf('.');
    if (dot === -1) return undefined;
    h = h.slice(dot + 1);
  }
}

// ---------------------------------------------------------------------------
// Timezones (docs/03): local_date/local_hour computed at ingest, cached per tz.
// ---------------------------------------------------------------------------

export interface LocalParts {
  /** 'YYYY-MM-DD' in the site's timezone. */
  date: string;
  /** 0–23 in the site's timezone. */
  hour: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    try {
      formatter = makeFormatter(timezone);
    } catch {
      formatter = makeFormatter('UTC'); // a bad site timezone must never break ingest
    }
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function makeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
}

export function localParts(timezone: string, ts: number): LocalParts {
  let year = '';
  let month = '';
  let day = '';
  let hour = 0;
  for (const part of formatterFor(timezone).formatToParts(new Date(ts))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hour = Number(part.value);
  }
  return { date: `${year}-${month}-${day}`, hour };
}
