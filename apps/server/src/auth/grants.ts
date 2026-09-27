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
import { parseSiteScope, serializeSiteScope } from './principal.ts';

/**
 * Site deletion companion (docs/04 § 5): no token or viewer scope keeps naming
 * a deleted site. A grant the deletion empties is revoked outright — a scope
 * of nothing is not a grant anyone meant to keep, and the admin lists should
 * say so. `'all'` scopes are untouched; they never named the site.
 */
export function dropSiteFromGrants(db: Db, siteId: number, now: number): void {
  for (const token of listApiTokens(db)) {
    const kept = scopeWithout(token.site_scope, siteId);
    if (kept === undefined) continue;
    setApiTokenScope(db, token.id, serializeSiteScope(kept));
    if (kept.length === 0) revokeApiToken(db, token.id, now);
  }
  for (const viewer of listViewers(db)) {
    const kept = scopeWithout(viewer.site_scope, siteId);
    if (kept === undefined) continue;
    setViewerScope(db, viewer.id, serializeSiteScope(kept));
    if (kept.length === 0 && revokeViewer(db, viewer.id, now)) {
      expireViewerMagicLinks(db, viewer.id, now);
    }
  }
}

/** The scope minus `siteId`, or undefined when it never listed the site. */
function scopeWithout(stored: string, siteId: number): number[] | undefined {
  const scope = parseSiteScope(stored);
  if (scope === 'all' || !scope.has(siteId)) return undefined;
  return [...scope].filter((id) => id !== siteId);
}
