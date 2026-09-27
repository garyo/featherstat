import {
  type Db,
  expireViewerMagicLinks,
  listApiTokens,
  listViewers,
  revokeApiToken,
  revokeViewer,
  setApiTokenScope,
  setViewerScope,
} from '../db/index.ts';
import { narrowScope, parseSiteScope, type SiteScope, serializeSiteScope } from './principal.ts';

interface Grant {
  created_by_user_id: number | null;
  revoked_at: number | null;
}

/**
 * Site deletion companion (docs/04 § 5): no token or viewer scope keeps naming
 * a deleted site. `'all'` scopes are untouched; they never named the site.
 */
export function dropSiteFromGrants(db: Db, siteId: number, now: number): void {
  fitGrants(
    db,
    () => true,
    (scope) =>
      scope === 'all' || !scope.has(siteId) ? undefined : [...scope].filter((id) => id !== siteId),
    now,
    true,
  );
}

/**
 * Keeps a user's standing grants inside their power: every token and viewer
 * they minted narrows to `sites`. Share links are not grants of the user's —
 * they belong to the dashboard, and whoever manages its site now revokes them
 * (docs/04 § 5).
 */
export function fitUserGrants(db: Db, userId: number, sites: readonly number[], now: number): void {
  const owned = new Set(sites);
  fitGrants(
    db,
    (grant) => grant.created_by_user_id === userId,
    (scope) => narrowScope(scope, owned),
    now,
    false,
  );
}

/**
 * Narrows every grant `picked` selects to what `fit` keeps (undefined: it
 * already fits), in the caller's transaction. A grant left with no site is
 * revoked outright, and a viewer's outstanding links go with it. `erase` is
 * deletion's rule — the site's id leaves every scope, revoked grants included;
 * otherwise revoked grants are left alone and an emptied one keeps the scope it
 * had, so the admin lists still say what it was for.
 */
function fitGrants(
  db: Db,
  picked: (grant: Grant) => boolean,
  fit: (scope: SiteScope) => number[] | undefined,
  now: number,
  erase: boolean,
): void {
  const refit = (grant: Grant & { site_scope: string }): number[] | undefined =>
    (erase || grant.revoked_at === null) && picked(grant)
      ? fit(parseSiteScope(grant.site_scope))
      : undefined;
  for (const token of listApiTokens(db)) {
    const kept = refit(token);
    if (kept === undefined) continue;
    if (erase || kept.length > 0) setApiTokenScope(db, token.id, serializeSiteScope(kept));
    if (kept.length === 0) revokeApiToken(db, token.id, now);
  }
  for (const viewer of listViewers(db)) {
    const kept = refit(viewer);
    if (kept === undefined) continue;
    if (erase || kept.length > 0) setViewerScope(db, viewer.id, serializeSiteScope(kept));
    if (kept.length === 0 && revokeViewer(db, viewer.id, now)) {
      expireViewerMagicLinks(db, viewer.id, now);
    }
  }
}
