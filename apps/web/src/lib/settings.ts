import type { AdminBotDrops } from '@featherstat/shared';

/** Pure helpers behind the settings view — kept out of the component for tests. */

/**
 * The native tag for a site (docs/04 § 2) against this deployment: `tracker.js`
 * as ESM, beaconing to `/api/collect` on `origin`.
 *
 * The Matomo-compatible shim this deployment also serves is deliberately not
 * offered here — it owns the `_paq` global, so it cannot run beside a real
 * Matomo tag while an operator compares the two. That path is a migration
 * step, documented in docs/06, not the way to start.
 */
export function trackingSnippet(siteId: number, origin: string): string {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return `<script type="module">
  import { init } from '${base}tracker.js';
  init({ site: ${siteId}, endpoint: '${base}api/collect' });
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
