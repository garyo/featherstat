import type { ResultRow } from '@featherstat/shared';
import type { BarRow } from './bar-rows.ts';
import { bucketLabel, compactNumber, exactNumber } from './format.ts';
import { num } from './series.ts';

/** A not-found page that did not say which path was asked for (older history). */
const UNKNOWN_PATH = '(path not reported)';

/**
 * Broken-link rows (docs/04 § 3 `missing`) as the shared bar rows draw them. The
 * server ranked them — linked-to paths first, since those are fixable — so this
 * only writes each row: the path asked for, how often, and the page that links
 * to it, which is the half that says where to go and fix it.
 *
 * Unfilterable: the path does not exist, so no other card has anything under it.
 */
export function brokenLinkBars(rows: readonly ResultRow[]): BarRow[] {
  const most = Math.max(1, ...rows.map((row) => num(row.hits)));
  return rows.map((row) => {
    const hits = num(row.hits);
    const referred = num(row.referred);
    const from = referrerOf(row);
    const lastSeen = typeof row.last_seen === 'string' ? bucketLabel(row.last_seen) : undefined;
    return {
      name: typeof row.path === 'string' ? row.path : UNKNOWN_PATH,
      value: hits,
      extra: 0,
      pct: ((hits / most) * 100).toFixed(1),
      filterValue: undefined,
      sub: [from === undefined ? 'no referrer' : `from ${from}`, lastSeen && `last ${lastSeen}`]
        .filter(Boolean)
        .join(' · '),
      tips: [
        { value: exactNumber(hits), label: 'hits' },
        { value: compactNumber(referred), label: 'with a referrer' },
        ...(from === undefined ? [] : [{ value: from, label: 'most often from' }]),
      ],
    };
  });
}

function referrerOf(row: ResultRow): string | undefined {
  if (typeof row.ref_domain !== 'string') return undefined;
  return row.ref_domain + (typeof row.ref_path === 'string' ? row.ref_path : '');
}
