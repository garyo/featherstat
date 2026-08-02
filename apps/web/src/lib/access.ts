/**
 * The pure half of the Access panels (API tokens + viewers): the site-scope
 * shape both share on the wire — `'all'` or a non-empty site-id list — as a
 * form draft, and the labels the list rows wear.
 */

export interface ScopeDraft {
  all: boolean;
  /** Checked site ids; ignored while `all` is on. */
  sites: number[];
}

export function emptyScope(): ScopeDraft {
  return { all: true, sites: [] };
}

/** The wire scope, or undefined while "some sites" has none checked. */
export function scopeOf(draft: ScopeDraft): 'all' | number[] | undefined {
  if (draft.all) return 'all';
  return draft.sites.length === 0 ? undefined : [...draft.sites].sort((a, b) => a - b);
}

/** Toggle one site in the checked list, immutably (the panels bind `$state`). */
export function toggleSite(sites: readonly number[], id: number): number[] {
  return sites.includes(id) ? sites.filter((site) => site !== id) : [...sites, id];
}

/** What a list row says a principal can read. */
export function scopeLabel(
  sites: 'all' | readonly number[],
  nameOf: (id: number) => string,
): string {
  if (sites === 'all') return 'all sites';
  return sites.map(nameOf).join(', ');
}
