import type { Dashboard } from '../index.ts';
import { acquisitionTemplate } from './acquisition.ts';
import { allSitesTemplate } from './all-sites.ts';
import { campaignsTemplate } from './campaigns.ts';
import { contentTemplate } from './content.ts';
import { overviewTemplate } from './overview.ts';

/**
 * The shipped dashboard templates (docs/05 § The dashboard library): typed
 * factories, shared because the server needs them too — reset rebuilds a clone
 * from its template, and a clone records which template it came from.
 *
 * A template is code, not a stored row: `build` emits a document at the CURRENT
 * vocabulary every time (parsed through `DashboardSchema` and carried by
 * `upgradeDashboard`, exactly like a stored layout), so shipped dashboards can
 * never be the documents a vocabulary change misses. In the library they appear
 * as virtual entries (`t:<id>` refs) beside stored rows; editing one clones it
 * first — the template itself is immutable.
 */
export interface DashboardTemplate {
  /** Stable id — the `t:<id>` library ref, and what `dashboards.template` records. */
  id: string;
  name: string;
  /** Which scope's library lists it: one site's dashboard, or the all-sites one. */
  scope: 'site' | 'all';
  /**
   * The template at a concrete scope. `site` is stamped into the document
   * (nominal — views scope the batch from the URL); `siteIds` feeds the
   * all-sites card grid and is ignored by site templates, the same live-directory
   * contract as `withLiveSiteIds`.
   */
  build(site: Dashboard['site'], siteIds?: readonly number[]): Dashboard;
}

/** Per scope, the FIRST entry is that scope's shipped default. */
export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  overviewTemplate,
  contentTemplate,
  acquisitionTemplate,
  campaignsTemplate,
  allSitesTemplate,
];

export function dashboardTemplate(id: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((template) => template.id === id);
}

export function templatesForScope(scope: 'site' | 'all'): DashboardTemplate[] {
  return DASHBOARD_TEMPLATES.filter((template) => template.scope === scope);
}

// Only the tiny dims module rides the root export: the detail template
// BUILDERS live behind `@featherstat/shared/detail-templates`, so the entry
// bundle's module graph never executes them — they belong to the code-split
// detail view (apps/web build.guard.ts markers prove it).
export * from './detail/dims.ts';
export {
  acquisitionTemplate,
  allSitesTemplate,
  campaignsTemplate,
  contentTemplate,
  overviewTemplate,
};
