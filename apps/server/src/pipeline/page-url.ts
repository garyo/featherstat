import { type CampaignField, MAX_URL_CHARS } from '@featherstat/shared';

/**
 * Page identity vs. tracking identifiers (docs/03 § Page identity).
 *
 * The query string is part of page identity (`?page=2`, `?q=owls` are
 * different pages) — but tracking identifiers are not: a click id or campaign
 * tag names the *visit*, not the page, and leaving it in `path` fragments
 * every per-page number (top pages, dwell, journeys, adjacency) one click at
 * a time. So `path` drops a CLOSED, documented list of tracking params and
 * keeps everything else, surviving params in their original order and text.
 *
 * Two lists, one rule:
 * - the campaign families the sessionizer reads (`utm_*`, `mtm_*`, `pk_*`,
 *   and Matomo's legacy `matomo_campaign` / `piwik_campaign` — `CAMPAIGN_PARAMS`
 *   is extracted before stripping);
 * - click/identity ids ad and email platforms append (`CLICK_ID_SOURCES` +
 *   `TRACKING_IDS` below).
 *
 * A subset of the click ids also carries an acquisition signal: `fbclid` with
 * no referrer is Facebook's in-app browser, not direct traffic. When a hit has
 * NO campaign params but does carry a click id, `clickIdSource` names the
 * platform so attribution can be synthesized the way Matomo/GA treat `gclid`
 * (docs/03 § Attribution). Real campaign params always win.
 */

/**
 * The params each campaign column is read from, in precedence order: `utm_*`
 * first, then Matomo's long and short forms — the names matomo.js and the
 * MarketingCampaignsReporting plugin accept by default, `pk_cpn` and
 * `mtm_src` among them. Every one is stripped from `path` below; reading all
 * of them is what keeps that stripping from being a loss of attribution.
 */
export const CAMPAIGN_PARAMS = {
  source: ['utm_source', 'mtm_source', 'mtm_src', 'pk_source', 'pk_src'],
  medium: ['utm_medium', 'mtm_medium', 'mtm_med', 'pk_medium', 'pk_med'],
  campaign: [
    'utm_campaign',
    'mtm_campaign',
    'mtm_cpn',
    'pk_campaign',
    'pk_cpn',
    'matomo_campaign',
    'piwik_campaign',
  ],
} as const satisfies Record<CampaignField, readonly string[]>;

/** Click ids that name their platform — ordered, first match wins. */
const CLICK_ID_SOURCES: ReadonlyArray<[param: string, source: string, medium: string]> = [
  ['gclid', 'google', 'cpc'],
  ['gbraid', 'google', 'cpc'],
  ['wbraid', 'google', 'cpc'],
  ['dclid', 'google', 'cpc'],
  ['fbclid', 'facebook', 'social'],
  ['msclkid', 'bing', 'cpc'],
  ['twclid', 'twitter', 'social'],
  ['ttclid', 'tiktok', 'social'],
  ['li_fat_id', 'linkedin', 'social'],
  ['igshid', 'instagram', 'social'],
  ['igsh', 'instagram', 'social'],
];

/** Tracking ids stripped from page identity but naming no platform (mail-merge
 * and marketing-automation recipient ids, Adobe/Yandex click ids). */
const TRACKING_IDS = [
  'mc_eid',
  'mc_cid',
  'yclid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_enc_id',
  'oly_anon_id',
  'vero_id',
  's_kwcid',
] as const;

/** Matomo's campaign params outside the `mtm_` / `pk_` families: the legacy
 * `matomo_` and `piwik_` spellings of the campaign name and keyword. */
const MATOMO_LEGACY_CAMPAIGN = ['matomo_campaign', 'piwik_campaign', 'matomo_kwd', 'piwik_kwd'];

const STRIPPED_PARAMS: ReadonlySet<string> = new Set([
  ...CLICK_ID_SOURCES.map(([param]) => param),
  ...TRACKING_IDS,
  ...MATOMO_LEGACY_CAMPAIGN,
]);

/** The campaign families, whole: every name in `CAMPAIGN_PARAMS` and their siblings (`utm_term`, `pk_kwd`, …). */
const CAMPAIGN_PREFIXES = ['utm_', 'mtm_', 'pk_'] as const;

/** Whether a query param is a tracking identifier rather than page identity. */
export function isTrackingParam(name: string): boolean {
  return STRIPPED_PARAMS.has(name) || CAMPAIGN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A `URL.search`-shaped string ('' or '?…') minus the tracking params.
 * Survivors keep their order and their exact text — the string is filtered,
 * never reserialized, so an unusual encoding survives untouched. Empty after
 * stripping collapses to '' (no trailing '?'); untouched input returns as-is.
 */
export function cleanSearch(search: string): string {
  if (search === '') return '';
  const pairs = search.slice(1).split('&');
  const kept = pairs.filter((pair) => !isTrackingParam(paramName(pair)));
  if (kept.length === pairs.length) return search;
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

function paramName(pair: string): string {
  const eq = pair.indexOf('=');
  const name = eq === -1 ? pair : pair.slice(0, eq);
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return name;
  }
}

/**
 * A received URL (fragment already dropped) cut to `max` characters, keeping
 * what a longer one is most worth: the tracking params go first, so a
 * campaign-tagged link whose own query ran long still attributes, and the
 * page's other params follow in order while they fit — a pair that does not
 * fit is left out whole, never cut mid-value. A URL whose path alone is too
 * long is simply sliced; there is no query left to save.
 */
export function boundUrl(raw: string, max: number = MAX_URL_CHARS): string {
  if (raw.length <= max) return raw;
  const cut = raw.indexOf('?');
  if (cut === -1 || cut >= max) return raw.slice(0, max);
  const pairs = raw.slice(cut + 1).split('&');
  const tracking = pairs.filter((pair) => isTrackingParam(paramName(pair)));
  const rest = pairs.filter((pair) => !isTrackingParam(paramName(pair)));
  let bounded = raw.slice(0, cut);
  for (const pair of [...tracking, ...rest]) {
    if (pair === '' || bounded.length + 1 + pair.length > max) continue;
    bounded += (bounded.length === cut ? '?' : '&') + pair;
  }
  return bounded;
}

/** The stored page identity of a parsed URL: pathname + cleaned query. */
export function cleanPageUrl(url: URL): string {
  return url.pathname + cleanSearch(url.search);
}

/**
 * Re-derives a stored `path` (pathname + search, docs/03) through the same
 * rule — the importer's healing pass. Guarded: a path that does not parse as
 * one (`new URL(path, base)`) is returned unchanged rather than mangled.
 */
export function cleanStoredPath(path: string): string {
  const cut = path.indexOf('?');
  if (cut === -1 || parseStoredPath(path) === undefined) return path;
  return path.slice(0, cut) + cleanSearch(path.slice(cut));
}

/** A stored `path` as a URL (for param reading), or undefined when malformed. */
export function parseStoredPath(path: string): URL | undefined {
  try {
    return new URL(path, 'http://x');
  } catch {
    return undefined;
  }
}

export interface ClickIdSource {
  source: string;
  medium: string;
}

/** The utm columns a synthesized (click-id-derived) attribution stores. */
export interface SynthesizedCampaign {
  utm_source: string | null;
  utm_medium: string | null;
  /** Never invented — a click id names a platform, not a campaign. */
  utm_campaign: null;
  /** Synthesized values keep NULL raws: nothing was normalized away. */
  utm_source_raw: null;
  utm_medium_raw: null;
  utm_campaign_raw: null;
}

/**
 * A click id's platform as stored utm columns — through the campaign
 * normalizer so operator aliases apply, but with NULL raws (the value is
 * derived, not received; there is no original to preserve). Shared by live
 * ingest (sessionizer) and the v1 importer so the two cannot disagree.
 */
export function synthesizedCampaign(
  clicked: ClickIdSource,
  siteId: number,
  normalize: (
    siteId: number,
    field: 'source' | 'medium',
    value: string,
  ) => { normalized: string | null },
): SynthesizedCampaign {
  return {
    utm_source: normalize(siteId, 'source', clicked.source).normalized,
    utm_medium: normalize(siteId, 'medium', clicked.medium).normalized,
    utm_campaign: null,
    utm_source_raw: null,
    utm_medium_raw: null,
    utm_campaign_raw: null,
  };
}

/**
 * The platform a click id names, or undefined when none is present. First
 * match in `CLICK_ID_SOURCES` order wins when several ride one URL. Values are
 * lowercase canonical; callers still route them through the campaign
 * normalizer so operator aliases apply (docs/03 § Campaigns).
 */
export function clickIdSource(params: URLSearchParams): ClickIdSource | undefined {
  for (const [param, source, medium] of CLICK_ID_SOURCES) {
    if (params.get(param)) return { source, medium };
  }
  return undefined;
}
