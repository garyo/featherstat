import {
  ENGAGEMENT_THRESHOLD_MS,
  type Hit,
  type HitContext,
  type HitType,
  PING_CLAMP_MS,
  SESSION_TIMEOUT_MS,
} from '@analytics/shared';

/**
 * Deterministic synthetic traffic for the replay harness (WP6, docs/08): 90 days
 * across the six sites of docs/01, shaped by weekday and time-of-day curves.
 *
 * Two products come out of one pass:
 *
 * 1. `hits` — (Hit, HitContext) pairs in timestamp order, ready to be encoded as
 *    matomo.php requests and pushed through the real ingest path.
 * 2. `totals` — per site per local day, counted by this module's own bookkeeping
 *    from the emitted stream using the rules of docs/03 (identity, 30-min idle
 *    timeout, engagement-aware bounce). Nothing here is derived by re-running the
 *    pipeline, so the replay test compares two independent implementations.
 *
 * Everything is driven by a seeded PRNG — `Math.random` is never called, so a
 * failure is always reproducible.
 */

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ReplaySite {
  id: number;
  name: string;
  domains: string[];
  timezone: string;
}

/** One tracking request as the transport would hand it to the pipeline. */
export interface ReplayHit {
  hit: Hit;
  ctx: HitContext;
}

/** Independently counted expectations for one site on one local date. */
export interface DayTotals {
  siteId: number;
  localDate: string;
  /** Distinct `visitor_id` values across every stored row of that local day. */
  visitors: number;
  /** Sessions whose *first* hit fell on that local day. */
  sessions: number;
  pageviews: number;
  /** docs/03: 1 pageview, no events, and engaged time under the threshold. */
  bounces: number;
  botDrops: number;
}

export interface Corpus {
  sites: ReplaySite[];
  /** Ascending by `ctx.receivedAt`; hits of one session keep their emitted order. */
  hits: ReplayHit[];
  /** Sorted by site id then local date; a day appears only if something happened. */
  totals: DayTotals[];
  /** Non-bot hits — the exact number of `events` rows a replay must produce. */
  storedHits: number;
  startMs: number;
  endMs: number;
}

export interface GenerateOptions {
  seed?: number;
  days?: number;
  /** First UTC day of the window; defaults to a span covering two DST switches. */
  startMs?: number;
}

/** Hits accepted between batch flushes in the replay and bench loops — one shared knob. */
export const REPLAY_HITS_PER_FLUSH = 500;

// ---------------------------------------------------------------------------
// Fixtures. IPs are RFC 5737 documentation addresses: real ones never appear in
// this repo, not even synthesized (CLAUDE.md invariant 3).
// ---------------------------------------------------------------------------

interface SiteProfile extends ReplaySite {
  /** Mean sessions on a weekday at the start of the window. */
  baseSessions: number;
  /** Weekend multiplier — apps dip hard, the blog barely notices. */
  weekend: number;
  visitors: number;
  /** Share of visitors whose tracker sends a stable Matomo `_id` (docs/03). */
  matomoIdShare: number;
  /** Server-side event hits per day — packzen's Clerk signup webhook (docs/01). */
  webhookEvents: number;
  paths: string[];
}

const SITES: SiteProfile[] = [
  {
    id: 1,
    name: 'pcons.org',
    domains: ['pcons.org'],
    timezone: 'America/New_York',
    baseSessions: 30,
    weekend: 0.5,
    visitors: 420,
    matomoIdShare: 0,
    webhookEvents: 0,
    paths: ['/', '/docs', '/docs/getting-started', '/docs/pcons-build', '/download', '/changelog'],
  },
  {
    id: 2,
    name: 'oberbrunner.com',
    domains: ['oberbrunner.com', 'blog.oberbrunner.com'],
    timezone: 'America/New_York',
    baseSessions: 46,
    weekend: 0.85,
    visitors: 900,
    matomoIdShare: 0,
    webhookEvents: 0,
    paths: [
      '/',
      '/about',
      '/blog',
      '/blog/sqlite-at-the-edge',
      '/blog/matomo-teardown',
      '/blog/typescript-notes',
      '/contact',
    ],
  },
  {
    id: 3,
    name: 'globe-viz',
    domains: ['globe-viz.oberbrunner.com'],
    timezone: 'UTC',
    baseSessions: 18,
    weekend: 0.7,
    visitors: 260,
    matomoIdShare: 0.8,
    webhookEvents: 0,
    paths: ['/', '/globe', '/globe?layer=temp', '/about'],
  },
  {
    id: 4,
    name: 'deep-timeline.org',
    domains: ['deep-timeline.org'],
    timezone: 'Europe/Berlin',
    baseSessions: 20,
    weekend: 0.75,
    visitors: 340,
    matomoIdShare: 0,
    webhookEvents: 0,
    paths: ['/', '/timeline', '/timeline/cambrian', '/timeline/holocene', '/sources'],
  },
  {
    id: 5,
    name: 'pelorus-nav.com',
    domains: ['pelorus-nav.com'],
    timezone: 'America/Los_Angeles',
    baseSessions: 14,
    weekend: 0.6,
    visitors: 180,
    matomoIdShare: 0.5,
    webhookEvents: 0,
    paths: ['/', '/app', '/app/route', '/pricing'],
  },
  {
    id: 6,
    name: 'packzen.org',
    domains: ['packzen.org'],
    timezone: 'Asia/Tokyo',
    baseSessions: 10,
    weekend: 0.65,
    visitors: 150,
    matomoIdShare: 0,
    webhookEvents: 3,
    paths: ['/', '/signup', '/pricing', '/docs/api'],
  },
];

const HUMAN_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];

/** Dropped by `isbot` at the door and counted, never stored (docs/03 § Bots). */
export const BOT_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
];

const BOT_AGENT_SET = new Set(BOT_AGENTS);

/**
 * The packzen signup webhook (docs/01) sends no `User-Agent`. That is deliberate:
 * `isbot` classifies every plausible server-side agent string ("curl/8", "node",
 * "…-webhook") as a bot, so a labelled sender would be dropped before storage.
 */
const WEBHOOK_AGENT = '';
const WEBHOOK_IP = '192.0.2.200';

const SCREENS = [
  '1920x1080',
  '2560x1440',
  '1512x982',
  '1440x900',
  '390x844',
  '412x915',
  '820x1180',
];

const LANGUAGES: Array<{ lang: string; accept: string }> = [
  { lang: 'en-us', accept: 'en-US,en;q=0.9' },
  { lang: 'en-gb', accept: 'en-GB,en;q=0.8' },
  { lang: 'de-de', accept: 'de-DE,de;q=0.9,en;q=0.6' },
  { lang: 'fr-fr', accept: 'fr-FR,fr;q=0.9,en;q=0.5' },
  { lang: 'ja-jp', accept: 'ja-JP,ja;q=0.9,en;q=0.4' },
  { lang: 'es-es', accept: 'es-ES,es;q=0.9' },
];

const REFERRERS = [
  'https://www.google.com/',
  'https://duckduckgo.com/',
  'https://news.ycombinator.com/',
  'https://bsky.app/profile/someone',
  'https://lobste.rs/',
  'https://mastodon.social/@someone',
  'https://github.com/garyo',
];

const CAMPAIGNS = [
  'utm_source=newsletter&utm_medium=email&utm_campaign=spring-release',
  'mtm_source=hn&mtm_medium=social&mtm_campaign=launch',
  'pk_source=sponsor&pk_medium=banner&pk_campaign=evergreen',
];

const EVENTS: Array<{ category: string; action: string; name?: string; value?: number }> = [
  { category: 'cta', action: 'click', name: 'try-it' },
  { category: 'video', action: 'play', name: 'intro' },
  { category: 'form', action: 'submit', name: 'contact' },
  { category: 'globe', action: 'rotate' },
  { category: 'pricing', action: 'toggle', name: 'annual', value: 1 },
];

const OUTLINKS = ['https://github.com/garyo/pcons', 'https://example.net/partner'];
const DOWNLOADS = ['/files/report.pdf', '/files/pcons-linux-x64.tar.gz'];

/** Local-hour weights: the shape of a real day, applied in each site's own timezone. */
const DIURNAL = [
  2, 1, 1, 1, 1, 2, 4, 8, 14, 20, 24, 25, 24, 22, 22, 23, 24, 22, 20, 18, 15, 11, 7, 4,
];
const DIURNAL_MAX = 25;
const WEEKDAY_SHAPE = [1, 1.05, 1.05, 1, 0.95];

const DAY_MS = 86_400_000;
const HEARTBEAT_MS = 15_000;
/** Growth across the window, so the timeseries widgets have a trend to draw. */
const GROWTH = 0.4;
const ENGAGED_SHARE = 0.62;
const ENGAGED_DWELL_MS = 18_000;
const ENGAGED_DWELL_SPREAD_MS = 210_000;
const SKIM_DWELL_MS = 1_000;
const SKIM_DWELL_SPREAD_MS = 11_000;
const MAX_PINGS_PER_STEP = 8;
/** Heartbeats are focus-gated, so a share of them never fires (docs/01). */
const PING_FOCUS_LOSS = 0.15;
const BOT_SHARE = 0.12;
/** A crawler takes this many pages in one burst. */
const BOT_BURST_PAGES = 3;
const CAMPAIGN_SHARE = 0.12;
const DIRECT_SHARE = 0.45;
const ACCEPT_LANGUAGE_SHARE = 0.85;
/** Not every webhook slot fires, so site 6's daily event count varies. */
const WEBHOOK_FIRE_SHARE = 0.7;
/** Probability of a session having 1, 2, … 6 steps. */
const STEP_WEIGHTS = [0.42, 0.22, 0.14, 0.1, 0.07, 0.05];
const TEST_NET_BLOCKS = ['192.0.2', '198.51.100', '203.0.113'];

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

type Rng = () => number;

/** mulberry32: 32 bits of state, uniform enough for traffic shaping, exactly reproducible. */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}

function hex(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(rng() * 16).toString(16);
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface Visitor {
  ip: string;
  userAgent: string;
  acceptLanguage: string | undefined;
  screen: string;
  lang: string;
  /** Matomo `_id`: when present it replaces the ip∥ua fingerprint (docs/03). */
  visitorId: string | undefined;
}

export function generateCorpus(options: GenerateOptions = {}): Corpus {
  const days = options.days ?? 90;
  const startMs = options.startMs ?? Date.UTC(2026, 1, 15);
  const rng = mulberry32(options.seed ?? 0x5eed_1e55);

  const pools = new Map(SITES.map((site) => [site.id, buildVisitors(site, rng)]));
  const hits: ReplayHit[] = [];

  for (let day = 0; day < days; day += 1) {
    const dayStart = startMs + day * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    for (const site of SITES) {
      const pool = pools.get(site.id) ?? [];
      const weekend = weekday === 0 || weekday === 6;
      const shape = weekend ? site.weekend : (WEEKDAY_SHAPE[weekday - 1] ?? 1);
      const trend = 1 + GROWTH * (day / days);
      const jitter = 0.75 + rng() * 0.5;
      const sessions = Math.round(site.baseSessions * shape * trend * jitter);
      for (let i = 0; i < sessions; i += 1) {
        emitSession(site, visitorFrom(rng, pool), startWithin(site, dayStart, rng), rng, hits);
      }
      emitBots(site, dayStart, Math.round(sessions * BOT_SHARE), rng, hits);
      emitWebhookEvents(site, dayStart, rng, hits);
    }
  }

  // Sort is stable, so hits sharing a millisecond keep the order they were emitted
  // in — a session's own steps can never be reordered against each other.
  hits.sort((a, b) => a.ctx.receivedAt - b.ctx.receivedAt);

  const { totals, storedHits } = account(hits);
  return { sites: SITES, hits, totals, storedHits, startMs, endMs: startMs + days * DAY_MS };
}

function buildVisitors(site: SiteProfile, rng: Rng): Visitor[] {
  const visitors: Visitor[] = [];
  for (let i = 0; i < site.visitors; i += 1) {
    const language = pick(rng, LANGUAGES);
    visitors.push({
      ip: documentationIp(rng),
      userAgent: pick(rng, HUMAN_AGENTS),
      acceptLanguage: rng() < ACCEPT_LANGUAGE_SHARE ? language.accept : undefined,
      screen: pick(rng, SCREENS),
      lang: language.lang,
      visitorId: rng() < site.matomoIdShare ? matomoVisitorId(site.id, i, rng) : undefined,
    });
  }
  return visitors;
}

/** RFC 5737 TEST-NET-1/2/3 — the documented addresses this repo is allowed to hold. */
function documentationIp(rng: Rng): string {
  return `${pick(rng, TEST_NET_BLOCKS)}.${1 + Math.floor(rng() * 254)}`;
}

/** 16 lowercase hex, unique within a site so two visitors never share an identity. */
function matomoVisitorId(siteId: number, index: number, rng: Rng): string {
  return siteId.toString(16).padStart(2, '0') + index.toString(16).padStart(6, '0') + hex(rng, 8);
}

/** Squaring the draw biases towards the front of the pool: a few visitors return often. */
function visitorFrom(rng: Rng, pool: readonly Visitor[]): Visitor {
  const draw = rng();
  const visitor = pool[Math.floor(draw * draw * pool.length)];
  if (visitor === undefined) throw new Error('empty visitor pool');
  return visitor;
}

/** Rejection-samples the diurnal curve against the site's *local* hour. */
function startWithin(site: SiteProfile, dayStart: number, rng: Rng): number {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ts = dayStart + Math.floor(rng() * DAY_MS);
    const weight = DIURNAL[localStamp(site.timezone, ts).hour] ?? 0;
    if (rng() * DIURNAL_MAX <= weight) return ts;
  }
  return dayStart + Math.floor(rng() * DAY_MS);
}

function emitSession(
  site: SiteProfile,
  visitor: Visitor,
  startMs: number,
  rng: Rng,
  out: ReplayHit[],
): void {
  const engaged = rng() < ENGAGED_SHARE;
  const steps = stepCount(rng);
  const host = pick(rng, site.domains);
  let url = entryUrl(site, host, rng);
  let referrer = entryReferrer(rng);
  let ts = startMs;

  for (let step = 0; step < steps; step += 1) {
    const type = step === 0 ? 'pageview' : stepType(rng);
    if (step > 0 && type === 'pageview') {
      referrer = url; // the page we came from — classified 'internal' if it mattered
      url = `https://${host}${pick(rng, site.paths)}`;
    }
    out.push(request(visitor, ts, buildHit(site, visitor, host, type, url, referrer, rng)));

    const dwell = engaged
      ? ENGAGED_DWELL_MS + Math.floor(rng() * ENGAGED_DWELL_SPREAD_MS)
      : SKIM_DWELL_MS + Math.floor(rng() * SKIM_DWELL_SPREAD_MS);
    if (engaged) emitPings(site, visitor, url, ts, dwell, rng, out);
    ts += dwell;
  }
}

/** `enableHeartBeatTimer(15)`: a ping every 15 s of the dwell, when the tab has focus. */
function emitPings(
  site: SiteProfile,
  visitor: Visitor,
  url: string,
  stepMs: number,
  dwellMs: number,
  rng: Rng,
  out: ReplayHit[],
): void {
  const beats = Math.min(Math.floor(dwellMs / HEARTBEAT_MS), MAX_PINGS_PER_STEP);
  for (let beat = 1; beat <= beats; beat += 1) {
    if (rng() < PING_FOCUS_LOSS) continue; // the tab lost focus for this beat
    const hit: Hit = { siteId: site.id, type: 'ping', url, visitorId: visitor.visitorId };
    out.push(request(visitor, stepMs + beat * HEARTBEAT_MS, hit));
  }
}

function emitBots(
  site: SiteProfile,
  dayStart: number,
  count: number,
  rng: Rng,
  out: ReplayHit[],
): void {
  for (let i = 0; i < count; i += 1) {
    const ts = dayStart + Math.floor(rng() * DAY_MS);
    const userAgent = pick(rng, BOT_AGENTS);
    const crawled = 1 + Math.floor(rng() * BOT_BURST_PAGES);
    for (let page = 0; page < crawled; page += 1) {
      const hit: Hit = {
        siteId: site.id,
        type: 'pageview',
        url: `https://${pick(rng, site.domains)}${pick(rng, site.paths)}`,
      };
      out.push({
        hit,
        ctx: { ip: documentationIp(rng), userAgent, receivedAt: ts + page * 2_000 },
      });
    }
  }
}

/** packzen's Clerk webhook: `e_c=signup&e_a=account-created`, no page (docs/01). */
function emitWebhookEvents(site: SiteProfile, dayStart: number, rng: Rng, out: ReplayHit[]): void {
  for (let i = 0; i < site.webhookEvents; i += 1) {
    if (rng() >= WEBHOOK_FIRE_SHARE) continue;
    const hit: Hit = {
      siteId: site.id,
      type: 'event',
      event: { category: 'signup', action: 'account-created' },
    };
    out.push({
      hit,
      ctx: {
        ip: WEBHOOK_IP,
        userAgent: WEBHOOK_AGENT,
        receivedAt: dayStart + Math.floor(rng() * DAY_MS),
      },
    });
  }
}

function request(visitor: Visitor, receivedAt: number, hit: Hit): ReplayHit {
  return {
    hit,
    ctx: {
      ip: visitor.ip,
      userAgent: visitor.userAgent,
      acceptLanguage: visitor.acceptLanguage,
      receivedAt,
    },
  };
}

function buildHit(
  site: SiteProfile,
  visitor: Visitor,
  host: string,
  type: HitType,
  url: string,
  referrer: string | undefined,
  rng: Rng,
): Hit {
  const hit: Hit = {
    siteId: site.id,
    type,
    url,
    screen: visitor.screen,
    lang: visitor.lang,
    visitorId: visitor.visitorId,
  };
  if (type === 'pageview') {
    hit.title = titleFor(url);
    hit.referrer = referrer;
  } else if (type === 'event') {
    hit.event = pick(rng, EVENTS);
  } else if (type === 'outlink') {
    hit.targetUrl = pick(rng, OUTLINKS);
  } else if (type === 'download') {
    hit.targetUrl = `https://${host}${pick(rng, DOWNLOADS)}`;
  }
  return hit;
}

function entryUrl(site: SiteProfile, host: string, rng: Rng): string {
  const url = `https://${host}${pick(rng, site.paths)}`;
  if (rng() >= CAMPAIGN_SHARE) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${pick(rng, CAMPAIGNS)}`;
}

function entryReferrer(rng: Rng): string | undefined {
  if (rng() < DIRECT_SHARE) return undefined;
  return pick(rng, REFERRERS);
}

function titleFor(url: string): string {
  const path = url.slice(url.indexOf('/', 'https://'.length)).split('?')[0] ?? '/';
  return path === '/' ? 'Home' : path.replace(/^\//, '').replace(/[-/]/g, ' ');
}

function stepCount(rng: Rng): number {
  let roll = rng();
  for (let i = 0; i < STEP_WEIGHTS.length; i += 1) {
    roll -= STEP_WEIGHTS[i] ?? 0;
    if (roll <= 0) return i + 1;
  }
  return STEP_WEIGHTS.length;
}

/** ~10 % of the steps after the entry are events; link tracking is the long tail (docs/01). */
function stepType(rng: Rng): HitType {
  const roll = rng();
  if (roll < 0.86) return 'pageview';
  if (roll < 0.96) return 'event';
  if (roll < 0.98) return 'outlink';
  return 'download';
}

// ---------------------------------------------------------------------------
// Bookkeeping — the oracle. A second, deliberately naive implementation of the
// docs/03 rules, run over the emitted stream. It shares no code with the server.
// ---------------------------------------------------------------------------

interface DayBucket {
  siteId: number;
  localDate: string;
  visitors: Set<string>;
  pageviews: number;
  sessions: number;
  bounces: number;
  botDrops: number;
}

interface CountedSession {
  siteId: number;
  localDate: string;
  pageviews: number;
  events: number;
  engagedMs: number;
  lastSeenAt: number;
}

function account(hits: readonly ReplayHit[]): { totals: DayTotals[]; storedHits: number } {
  const zones = new Map(SITES.map((site) => [site.id, site.timezone]));
  const buckets = new Map<string, DayBucket>();
  const open = new Map<string, CountedSession>();
  const sessions: CountedSession[] = [];
  let storedHits = 0;

  for (const { hit, ctx } of hits) {
    const timezone = zones.get(hit.siteId) ?? 'UTC';
    const localDate = localStamp(timezone, ctx.receivedAt).date;
    const bucket = bucketFor(buckets, hit.siteId, localDate);
    if (BOT_AGENT_SET.has(ctx.userAgent)) {
      bucket.botDrops += 1;
      continue;
    }
    storedHits += 1;

    // The visitor hash mixes in the site and a salt that rotates at 00:00 UTC, so
    // one person is a different visitor on either side of a UTC midnight (docs/03).
    const identity = `${hit.siteId}|${Math.floor(ctx.receivedAt / DAY_MS)}|${fingerprint(hit, ctx)}`;
    bucket.visitors.add(identity);

    let session = open.get(identity);
    if (session === undefined || ctx.receivedAt - session.lastSeenAt > SESSION_TIMEOUT_MS) {
      session = {
        siteId: hit.siteId,
        localDate,
        pageviews: 0,
        events: 0,
        engagedMs: 0,
        lastSeenAt: ctx.receivedAt,
      };
      open.set(identity, session);
      sessions.push(session);
    } else {
      const gap = ctx.receivedAt - session.lastSeenAt;
      session.engagedMs += Math.min(Math.max(gap, 0), PING_CLAMP_MS);
      session.lastSeenAt = ctx.receivedAt;
    }

    if (hit.type === 'pageview') {
      session.pageviews += 1;
      bucket.pageviews += 1;
    } else if (hit.type === 'event') {
      session.events += 1;
    }
  }

  for (const session of sessions) {
    const bucket = bucketFor(buckets, session.siteId, session.localDate);
    bucket.sessions += 1;
    const bounced =
      session.pageviews === 1 &&
      session.events === 0 &&
      session.engagedMs < ENGAGEMENT_THRESHOLD_MS;
    if (bounced) bucket.bounces += 1;
  }

  const totals = [...buckets.values()]
    .map(({ visitors, ...bucket }) => ({ ...bucket, visitors: visitors.size }))
    .sort((a, b) => a.siteId - b.siteId || a.localDate.localeCompare(b.localDate));
  return { totals, storedHits };
}

function bucketFor(buckets: Map<string, DayBucket>, siteId: number, localDate: string): DayBucket {
  const key = `${siteId}|${localDate}`;
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = {
      siteId,
      localDate,
      visitors: new Set(),
      pageviews: 0,
      sessions: 0,
      bounces: 0,
      botDrops: 0,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** The hash input of docs/03: `_id` when the tracker sends one, else ip ∥ user agent. */
function fingerprint(hit: Hit, ctx: HitContext): string {
  return hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`;
}

// ---------------------------------------------------------------------------
// Local time. Derived from the zone's UTC offset rather than by formatting the
// date, so a bug in the server's own local_date/local_hour cannot hide here.
// ---------------------------------------------------------------------------

interface LocalStamp {
  date: string;
  hour: number;
}

/** Every real zone offset is a whole quarter-hour, so a bucket never straddles an hour. */
const STAMP_BUCKET_MS = 900_000;
const stampCache = new Map<string, LocalStamp>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function localStamp(timezone: string, ts: number): LocalStamp {
  const key = `${timezone}|${Math.floor(ts / STAMP_BUCKET_MS)}`;
  let stamp = stampCache.get(key);
  if (stamp === undefined) {
    const shifted = new Date(ts + zoneOffsetMs(timezone, ts));
    stamp = { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
    stampCache.set(key, stamp);
  }
  return stamp;
}

function zoneOffsetMs(timezone: string, ts: number): number {
  let formatter = offsetFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    offsetFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(ts);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(name);
  if (match === null) return 0;
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours ?? '0') * 3_600_000 + Number(minutes ?? '0') * 60_000;
  return sign === '-' ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// Transport encoding
// ---------------------------------------------------------------------------

/**
 * Renders a hit back into the matomo.php query string a tracker would send, so the
 * replay runs through the real parser instead of hand-feeding the pipeline.
 */
export function toMatomoQuery({ hit }: ReplayHit): URLSearchParams {
  const query = new URLSearchParams();
  query.set('idsite', String(hit.siteId));
  query.set('rec', '1');
  if (hit.url !== undefined) query.set('url', hit.url);
  if (hit.title !== undefined) query.set('action_name', hit.title);
  if (hit.referrer !== undefined) query.set('urlref', hit.referrer);
  if (hit.type === 'ping') query.set('ping', '1');
  if (hit.targetUrl !== undefined) {
    query.set(hit.type === 'download' ? 'download' : 'link', hit.targetUrl);
  }
  if (hit.event !== undefined) {
    query.set('e_c', hit.event.category);
    query.set('e_a', hit.event.action);
    if (hit.event.name !== undefined) query.set('e_n', hit.event.name);
    if (hit.event.value !== undefined) query.set('e_v', String(hit.event.value));
  }
  if (hit.screen !== undefined) query.set('res', hit.screen);
  if (hit.lang !== undefined) query.set('lang', hit.lang);
  if (hit.visitorId !== undefined) query.set('_id', hit.visitorId);
  query.set('send_image', '0');
  query.set('rand', '0'); // matomo.js cache-buster: an unknown param the parser ignores
  return query;
}
