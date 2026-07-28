import type { Dashboard } from '@featherstat/shared';
import type { SiteScope } from './state.ts';

/**
 * The dashboard persistence contract (docs/05 § Widgets): the built-in
 * dashboards are shipped JSON; a stored row for the same scope replaces them.
 * This module is the pure half — wire shapes and resolution rules; the
 * reactive store lives in `dashboards.svelte.ts`.
 */

/** List row of `GET /api/admin/dashboards` (the server's `DashboardInfo`). */
export interface DashboardInfo {
  id: number;
  name: string;
  site: Dashboard['site'];
  updatedAt: number;
}

/** Detail row: the list fields plus the full validated layout. */
export interface DashboardDetail extends DashboardInfo {
  layout: Dashboard;
}

/**
 * The stored dashboard a scope renders, if any: the OLDEST row whose scope
 * matches, so the canonical dashboard survives someone minting extras — the
 * same deterministic-order instinct as the site-cards sort tiebreaks.
 */
export function storedDashboardFor(
  list: readonly DashboardInfo[],
  scope: SiteScope,
): DashboardInfo | undefined {
  let best: DashboardInfo | undefined;
  for (const info of list) {
    if (info.site === scope && (best === undefined || info.id < best.id)) best = info;
  }
  return best;
}

/**
 * A stored all-sites layout froze `options.siteIds` at save time; the batch must
 * follow the LIVE directory or a new site never gets its R20 page queries.
 * Returns the same object when nothing changes, so derived state stays stable.
 */
export function withLiveSiteIds(dashboard: Dashboard, siteIds: readonly number[]): Dashboard {
  let changed = false;
  const grid = dashboard.grid.map((spec) => {
    if (spec.viz !== 'site-cards' || sameIds(spec.options.siteIds, siteIds)) return spec;
    changed = true;
    return { ...spec, options: { ...spec.options, siteIds: [...siteIds] } };
  });
  return changed ? { ...dashboard, grid } : dashboard;
}

function sameIds(raw: unknown, siteIds: readonly number[]): boolean {
  return (
    Array.isArray(raw) &&
    raw.length === siteIds.length &&
    siteIds.every((id, index) => raw[index] === id)
  );
}
