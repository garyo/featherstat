import { createHash } from 'node:crypto';
import { getDomain, getDomainWithoutSuffix } from 'tldts';

/**
 * Referrer hosts (docs/03 § Attribution). `ref_domain` stores the **canonical**
 * domain and `ref_domain_raw` the received hostname, kept only when
 * canonicalization changed it — the same shape as `utm_*` / `utm_*_raw`, and
 * for the same reason: the backfill re-derives from `COALESCE(raw, current)`,
 * so any sequence of runs converges.
 *
 * Canonical means the registrable domain — eTLD+1 under the Public Suffix List,
 * via `tldts` (MIT, bundles the list). One rule collapses `go.bsky.app`,
 * `m.facebook.com`, `ca.search.yahoo.com` and `old.reddit.com` onto the source
 * a reader would name, and it subsumes stripping `www.`.
 *
 * Two hand-written tables cover what eTLD+1 alone gets wrong, in both
 * directions. Neither is derived from another analytics project's data:
 * Matomo's lists are GPL-3 and Plausible's AGPL, so this repo (MIT) may take
 * neither. Snowplow's referer-parser (Apache-2.0) is compatible and served as
 * inspiration only.
 *
 * This module is server-only ON PURPOSE: `tldts` carries the whole Public
 * Suffix List, and `packages/shared` ships to the browser. The web never
 * canonicalizes — it displays what the server stored.
 */

/**
 * Hosts exempt from collapsing, because the subdomain names a genuinely
 * different source and merging it would lose the answer the report exists to
 * give. Google News is not Google Search; Hacker News is not Y Combinator.
 */
const KEEP_DISTINCT: ReadonlySet<string> = new Set([
  // Separate Google products that happen to share a registrable domain.
  'news.google.com',
  'scholar.google.com',
  'groups.google.com',
  'mail.google.com',
  'translate.google.com',
  'gemini.google.com',
  // Also the key the search/social table below matches on — collapsing it to
  // ycombinator.com would silently reclassify Hacker News as a plain referral.
  'news.ycombinator.com',
  // Assistant referrals are their own acquisition channel, not the vendor site.
  // Only the ones whose registrable domain belongs to something else need to be
  // here: `claude.ai` and `chatgpt.com` are already their own.
  'chat.openai.com',
  'copilot.microsoft.com',
]);

/**
 * Distinct registrable domains that mean one source. Two dozen entries by
 * design — the long tail belongs to eTLD+1, not to a list somebody must feed.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  // Short-link domains.
  ['t.co', 'twitter.com'],
  ['fb.me', 'facebook.com'],
  ['lnkd.in', 'linkedin.com'],
  ['youtu.be', 'youtube.com'],
  ['redd.it', 'reddit.com'],
  ['t.me', 'telegram.org'],
  ['wa.me', 'whatsapp.com'],
  ['discord.gg', 'discord.com'],
  ['flip.it', 'flipboard.com'],
  ['goo.gl', 'google.com'],
  ['g.co', 'google.com'],
  // `android-app://<package>` referrers: the URL parser reads the reverse-DNS
  // package id as the hostname, so `com.slack` is literally what arrives — and
  // eTLD+1 would answer `android.gm` for Gmail's, which names nothing.
  ['com.slack', 'slack.com'],
  ['com.google.android.gm', 'gmail.com'],
  ['com.google.android.googlequicksearchbox', 'google.com'],
  ['com.facebook.katana', 'facebook.com'],
  ['com.facebook.orca', 'facebook.com'],
  ['com.twitter.android', 'twitter.com'],
  ['com.linkedin.android', 'linkedin.com'],
  ['com.instagram.android', 'instagram.com'],
  ['com.reddit.frontpage', 'reddit.com'],
  ['com.microsoft.office.outlook', 'outlook.com'],
  ['org.telegram.messenger', 'telegram.org'],
]);

/** We hand `tldts` a bare hostname, never a URL, and want ICANN suffixes only:
 * with private suffixes on, `vercel.app` and `notion.site` have no registrable
 * domain at all and would canonicalize to nothing. */
const PSL_OPTIONS = { extractHostname: false, mixedInputs: false } as const;

/** The canonical domain for a received hostname. Total: it always answers. */
export function canonicalReferrerDomain(host: string): string {
  const bare = bareHost(host);
  if (KEEP_DISTINCT.has(bare)) return bare;
  const aliased = ALIASES.get(bare);
  if (aliased !== undefined) return aliased;
  // `null` for an IP literal, a single-label host, or anything the list cannot
  // place — the received host is then the most canonical form there is.
  const registrable = getDomain(bare, PSL_OPTIONS) ?? bare;
  return ALIASES.get(registrable) ?? registrable;
}

function bareHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, ''); // the silent root label
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

type ReferrerType = 'internal' | 'search' | 'social' | 'referral';

export interface ReferrerAttribution {
  /** The canonical domain; null when there was no usable referrer. */
  ref_domain: string | null;
  /** The received hostname, ONLY when canonicalization changed it. */
  ref_domain_raw: string | null;
  /** `undefined` when there was no usable referrer — the caller reads it as direct. */
  ref_type: ReferrerType | undefined;
}

const NO_REFERRER: ReferrerAttribution = {
  ref_domain: null,
  ref_domain_raw: null,
  ref_type: undefined,
};

/**
 * Everything a session's first hit needs from its `Referer` (docs/03).
 * `landingHost` is the hostname of the page the hit landed on: a referrer from
 * that same host is the site itself, whatever its domain list says.
 */
export function referrerAttribution(
  referrer: string | undefined,
  domains: readonly string[],
  landingHost?: string | null,
): ReferrerAttribution {
  const host = referrerHost(referrer);
  if (host === null) return NO_REFERRER;
  const canonical = canonicalReferrerDomain(host);
  const stored = {
    ref_domain: canonical,
    ref_domain_raw: canonical === host ? null : host,
  };
  // Own-domain matching stays on the RECEIVED host: a site registered as
  // `docs.example.com` would not match its own eTLD+1.
  if (host === landingHost || isInternal(host, domains)) {
    return { ...stored, ref_type: 'internal' };
  }
  return { ...stored, ref_type: referrerTypeOf(canonical) };
}

/**
 * The type a referrer alone implies. `internal` and `campaign` are NOT
 * derivable from the host — they need the site's domains and the landing URL —
 * so the backfill only ever re-derives rows already carrying one of these.
 */
export function referrerTypeOf(canonical: string): 'search' | 'social' | 'referral' {
  return knownReferrerType(canonical) ?? 'referral';
}

/** The received hostname, lowercased — hostnames are case-insensitive. */
function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A configured domain may carry a port (`localhost:4321`); a referrer's hostname never does. */
function isInternal(host: string, domains: readonly string[]): boolean {
  return domains.some((entry) => {
    const domain = bareHost(entry.replace(/:\d+$/, ''));
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/**
 * Search engines that answer under a country domain as well as `.com` —
 * `google.com.mx`, `google.pl`, `yahoo.co.jp`, `yandex.ua`. Matched on the
 * registrable domain's own label, so every suffix they operate under is
 * covered without a table row per country, which a table never keeps up with.
 */
const SEARCH_BRANDS: ReadonlySet<string> = new Set(['google', 'bing', 'yahoo', 'yandex']);

/** Small built-in search/social table (docs/03): the long tail is not worth a database. */
const KNOWN_REFERRERS: Record<string, 'search' | 'social'> = {
  // search (Google, Bing, Yahoo and Yandex are SEARCH_BRANDS, on every suffix)
  'duckduckgo.com': 'search',
  'baidu.com': 'search',
  'ecosia.org': 'search',
  'qwant.com': 'search',
  'brave.com': 'search',
  'startpage.com': 'search',
  'kagi.com': 'search',
  'ask.com': 'search',
  'aol.com': 'search',
  'naver.com': 'search',
  'seznam.cz': 'search',
  // Assistants, as a form of search: someone asked a question and arrived at an
  // answer, which is what the channel means. They are NOT their own `ref_type`
  // — that enum is stored on every row and read by the rollups, so a new member
  // is a migration; `ref_domain` already separates them from Google. Gemini and
  // Copilot reach this table through KEEP_DISTINCT, which is what keeps them
  // distinct rows while `knownReferrerType`'s suffix walk still classifies them.
  'chatgpt.com': 'search',
  'chat.openai.com': 'search',
  'claude.ai': 'search',
  'perplexity.ai': 'search',
  'copilot.microsoft.com': 'search',
  'gemini.google.com': 'search',
  'you.com': 'search',
  'phind.com': 'search',
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

/**
 * Walks host suffixes, so a KEEP_DISTINCT host still reaches its parent's
 * entry: `news.google.com` stays its own row and is still `search`.
 */
function knownReferrerType(host: string): 'search' | 'social' | undefined {
  for (let h = host; ; ) {
    const type = KNOWN_REFERRERS[h];
    if (type !== undefined) return type;
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  const brand = getDomainWithoutSuffix(host, PSL_OPTIONS);
  return brand !== null && SEARCH_BRANDS.has(brand) ? 'search' : undefined;
}

/**
 * A fingerprint of the tables above — everything that decides a canonical
 * domain or its type.
 *
 * These tables are code, so there is no alias-edit endpoint to re-arm the
 * backfill the way `campaign_aliases` has. Instead the job compares this to the
 * value it last completed with and re-arms itself when they differ, which makes
 * editing a table all it takes to relabel history — the property the campaign
 * aliases already have, and the one that makes these tables safe to grow.
 */
export function referrerTablesFingerprint(): string {
  const parts = [
    [...KEEP_DISTINCT].sort().join(','),
    [...ALIASES]
      .map(([from, to]) => `${from}>${to}`)
      .sort()
      .join(','),
    Object.entries(KNOWN_REFERRERS)
      .map(([host, type]) => `${host}=${type}`)
      .sort()
      .join(','),
    [...SEARCH_BRANDS].sort().join(','),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
