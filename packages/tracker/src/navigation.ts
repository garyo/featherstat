/**
 * Which history changes are a new page view, for the native tracker's
 * automatic page views (docs/04 § 2).
 *
 * - **A fragment never is.** An in-page anchor, a table of contents, a hash tab:
 *   the reader is still on the page, and the server strips the fragment from
 *   `path` anyway, so a view here would be a second row for the same page.
 * - **`pushState` and back/forward are, when the path or the query moved.** The
 *   query is page identity (`?page=2` is another page, docs/03 § Page identity).
 * - **`replaceState` is, only when the path moved.** A router's redirect or
 *   `router.replace` lands on another page; a replace that rewrites only the
 *   query is the app keeping its state in the address bar — a search box on
 *   every keystroke, a filter, a sort — and counting it records a view per
 *   keystroke. Plausible goes further and ignores `replaceState` outright,
 *   which misses the redirect; this keeps the redirect and drops the typing.
 */
export type HistoryChange = 'push' | 'replace' | 'pop';

export function isNewView(from: string, to: string, change: HistoryChange): boolean {
  // Runs inside the app's own `pushState`: it must answer, never throw.
  try {
    const before = new URL(from);
    const after = new URL(to);
    if (before.origin !== after.origin || before.pathname !== after.pathname) return true;
    return change !== 'replace' && before.search !== after.search;
  } catch {
    return from !== to;
  }
}
