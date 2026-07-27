import type { AdminBotDrops } from '@analytics/shared';

/** Pure helpers behind the settings view — kept out of the component for tests. */

/**
 * The Matomo-compatible tag for a site (docs/04 § 1) against this deployment.
 * The shim serves from `/matomo.js` and beacons to `/matomo.php` on `origin`.
 */
export function trackingSnippet(siteId: number, origin: string): string {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return `<script>
  var _paq = window._paq = window._paq || [];
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  _paq.push(['enableHeartBeatTimer']);
  (function () {
    var u = '${base}';
    _paq.push(['setTrackerUrl', u + 'matomo.php']);
    _paq.push(['setSiteId', '${siteId}']);
    var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
    g.async = true; g.src = u + 'matomo.js'; s.parentNode.insertBefore(g, s);
  })();
</${'script'}>`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `12.4 MB` — diagnostics-grade rounding, not accounting. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** `"blog.test, www.blog.test"` → `['blog.test', 'www.blog.test']`. */
export function parseDomains(input: string): string[] {
  return input
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');
}

/** Per-site totals over the diagnostics window, largest first. */
export function botDropTotals(drops: readonly AdminBotDrops[]): Array<[number, number]> {
  const totals = new Map<number, number>();
  for (const drop of drops) totals.set(drop.siteId, (totals.get(drop.siteId) ?? 0) + drop.count);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}
