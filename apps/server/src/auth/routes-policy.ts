/**
 * The admin wall's classification (docs/04 § 5). Every `/api/admin/*` route is
 * either MANAGER (admin or user; its handler then checks `canManageSite` per
 * object) or ADMIN — and admin is the default, so a route added tomorrow is
 * born admin-only exactly as it is born authenticated. The explicit list below
 * is the entire opening; `auth/app.test.ts` pins the matrix.
 *
 * What opens to users is the per-site management surface: their sites,
 * dashboards, goals, campaigns, annotations, the viewers/tokens they mint
 * (bounded to their own scope in the handlers), and self-service (logout,
 * password). What stays admin-only is everything instance-wide: user accounts,
 * data settings, prop scrubs, exclusions, diagnostics, notifications, and the
 * global-namespace objects (segments, derived metrics, campaign aliases,
 * alert rules) — users read those, only the admin writes them.
 */

const MANAGER_EXACT = new Set([
  'POST /api/admin/logout',
  'POST /api/admin/password',
  'POST /api/admin/sites',
]);

/** Whole subtrees (the path itself and everything under it), any method. */
const MANAGER_PREFIXES = [
  '/api/admin/sites/',
  '/api/admin/dashboards',
  '/api/admin/goals',
  '/api/admin/campaigns',
  '/api/admin/annotations',
  '/api/admin/viewers',
  '/api/admin/tokens',
];

export function isManagerRoute(method: string, path: string): boolean {
  if (MANAGER_EXACT.has(`${method} ${path}`)) return true;
  return MANAGER_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}
