import {
  type Dashboard,
  type DashboardTemplate,
  dashboardTemplate,
  templatesForScope,
} from '@featherstat/shared';
import type { DashRef, SiteScope } from './state.ts';

/**
 * The dashboard library (docs/05 § The dashboard library): a scope's list is
 * the shipped templates (virtual `t:<id>` entries, code not rows) plus its
 * stored rows. This module is the pure half — wire shapes and resolution
 * rules; the reactive store lives in `dashboards.svelte.ts`.
 */

/** List row of `GET /api/admin/dashboards` (the server's `DashboardInfo`). */
export interface DashboardInfo {
  id: number;
  name: string;
  site: Dashboard['site'];
  /** Shipped-template id this row was cloned from (the reset target); null otherwise. */
  template: string | null;
  createdAt: number;
  updatedAt: number;
  /** Live share links pointing at this row — what deleting it would revoke. */
  shareCount: number;
}

/** Detail row: the list fields plus the full validated layout. */
export interface DashboardDetail extends DashboardInfo {
  layout: Dashboard;
}

/** One line of the switcher: a shipped template, or a stored row. */
export type LibraryEntry =
  | { kind: 'template'; ref: `t:${string}`; name: string; template: DashboardTemplate }
  | { kind: 'stored'; ref: number; name: string; info: DashboardInfo };

/**
 * A scope's library, in display order: shipped templates first (registry
 * order), then stored rows oldest first — `created_at` with the row id as the
 * tiebreak, the same deterministic-order instinct as the site-cards sort.
 */
export function libraryFor(list: readonly DashboardInfo[], scope: SiteScope): LibraryEntry[] {
  const templates: LibraryEntry[] = templatesForScope(scope === 'all' ? 'all' : 'site').map(
    (template) => ({ kind: 'template', ref: `t:${template.id}`, name: template.name, template }),
  );
  const stored: LibraryEntry[] = list
    .filter((info) => info.site === scope)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
    .map((info) => ({ kind: 'stored', ref: info.id, name: info.name, info }));
  return [...templates, ...stored];
}

/**
 * What a `?dash=` ref means inside a scope's library. Absent — or naming
 * something the scope does not have — resolves to the scope's DEFAULT: the
 * oldest stored row if any (exactly v1's singleton rule, so an install that
 * never touches the library sees no change), else the shipped default, which
 * is the first template of the scope.
 */
export function resolveDashRef(
  library: readonly LibraryEntry[],
  dash: DashRef | undefined,
): LibraryEntry | undefined {
  if (dash !== undefined) {
    const named = library.find((entry) => entry.ref === dash);
    if (named !== undefined) return named;
  }
  return library.find((entry) => entry.kind === 'stored') ?? library[0];
}

/**
 * A shipped template built for a scope — the document a view renders when the
 * selection is virtual. Falls back to the scope's default template, so even a
 * mangled ref renders a dashboard, not an error.
 */
export function builtTemplate(
  id: string | undefined,
  scope: SiteScope,
  siteIds: readonly number[] = [],
): Dashboard {
  const template =
    (id === undefined ? undefined : dashboardTemplate(id)) ??
    templatesForScope(scope === 'all' ? 'all' : 'site')[0];
  if (template === undefined) throw new Error('no shipped template for this scope');
  return template.build(scope, siteIds);
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
