import type { AdminBotDrops, AdminDataSettings } from '@featherstat/shared';

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

/** UTC ms → what a `datetime-local` input holds (the browser's zone, minutes). */
export function msToLocalInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

/** A `datetime-local` value → UTC ms, or undefined while the input is blank/partial.
 * The shape check matters: `Date` happily reads half-typed strings as real dates. */
export function localInputToMs(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Per-site totals over the diagnostics window, largest first — bot drops or excluded ones. */
export function dropTotals(drops: readonly AdminBotDrops[]): Array<[number, number]> {
  const totals = new Map<number, number>();
  for (const drop of drops) totals.set(drop.siteId, (totals.get(drop.siteId) ?? 0) + drop.count);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The retention/backup form as its inputs hold it. The two counts are
 * `type="number"` inputs, whose binding yields a number — or null once cleared —
 * never a string.
 */
export interface DataSettingsDraft {
  /** Null keeps raw events forever. */
  retention: number | null;
  backupDir: string;
  /** Null only while the box is empty — there is no "forever" for backups. */
  backupKeep: number | null;
}

export function dataSettingsDraft(settings: AdminDataSettings): DataSettingsDraft {
  return {
    retention: settings.retentionDays,
    backupDir: settings.backupDir ?? '',
    backupKeep: settings.backupKeep,
  };
}

/** The PUT body for a draft, or what is missing from it. */
export function dataSettingsBody(
  draft: DataSettingsDraft,
): { body: AdminDataSettings } | { error: string } {
  if (draft.backupKeep === null) return { error: 'say how many backups to keep' };
  const dir = draft.backupDir.trim();
  return {
    body: {
      retentionDays: draft.retention,
      backupDir: dir === '' ? null : dir,
      backupKeep: draft.backupKeep,
    },
  };
}

/**
 * Whether a form's draft differs from what it was opened on — the question a
 * Settings section switch asks before it discards a panel. Compared as the JSON
 * each would send, so an edit typed and then undone reads as no edit at all.
 */
export function edited(draft: unknown, opened: unknown): boolean {
  return JSON.stringify(draft) !== JSON.stringify(opened);
}
