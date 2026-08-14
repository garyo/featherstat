/**
 * Who is asking (docs/04 § 5). Every gated request resolves to exactly one of
 * these, in one place (auth.gate), and every site-scoped read goes through
 * `readableSites`/`canReadSite` — the one chokepoint that keeps a scoped
 * principal from widening itself. Admin and users are the writers — a user
 * only within the sites they own (`canManageSite`); viewers and tokens are
 * read-only by construction (the admin surface requires a manager).
 */

export type SiteScope = 'all' | ReadonlySet<number>;

export type Principal =
  | { kind: 'admin'; sessionId: string }
  | { kind: 'user'; sessionId: string; userId: number; sites: ReadonlySet<number> }
  | { kind: 'viewer'; sessionId: string; viewerId: number; sites: SiteScope }
  | { kind: 'token'; tokenId: number; sites: SiteScope };

export function isAdmin(principal: Principal): boolean {
  return principal.kind === 'admin';
}

/** A principal that may hold the management surface at all: admin or user. */
export function isManager(principal: Principal): boolean {
  return principal.kind === 'admin' || principal.kind === 'user';
}

export function canReadSite(principal: Principal, siteId: number): boolean {
  if (principal.kind === 'admin') return true;
  return principal.sites === 'all' || principal.sites.has(siteId);
}

/** Writing is narrower than reading: only the admin and the owning user. */
export function canManageSite(principal: Principal, siteId: number): boolean {
  if (principal.kind === 'admin') return true;
  return principal.kind === 'user' && principal.sites.has(siteId);
}

/** `site: "all"` means "all sites this principal can read" — never more. */
export function readableSites(principal: Principal, all: readonly number[]): number[] {
  return all.filter((siteId) => canReadSite(principal, siteId));
}

/**
 * The `site_scope` column: `'all'` or a JSON array of site ids. Stored rows
 * are re-validated on every read — a hand-edited row fails closed (no sites),
 * never open. Validated by hand because the server deliberately has no zod
 * dependency of its own; boundary schemas live in @featherstat/shared, and
 * this is a storage format, not a boundary.
 */
export function parseSiteScope(stored: string): SiteScope {
  if (stored === 'all') return 'all';
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every((id) => Number.isInteger(id) && id > 0)) {
      return new Set(parsed as number[]);
    }
  } catch {
    // fall through to the empty scope
  }
  return new Set();
}

export function serializeSiteScope(scope: 'all' | readonly number[]): string {
  return scope === 'all' ? 'all' : JSON.stringify([...scope]);
}
