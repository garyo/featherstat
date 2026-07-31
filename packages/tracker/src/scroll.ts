/**
 * How far down a page the reader got, as a whole percentage.
 *
 * Time on page says they stayed; it cannot say they read. A 46-second visit to
 * a long article and a 46-second visit that never left the header are the same
 * number today, and this is the second number that tells them apart.
 *
 * The viewport counts. `scrollY / documentHeight` can never reach 100 and reads
 * 0 on a page with no scrollbar at all; what the reader has SEEN is everything
 * above the bottom of the viewport, so the numerator is `scrollY + viewportH`.
 * A page that fits without scrolling is therefore 100, which is honest — they
 * did see all of it — and stays comparable because the figure is only ever read
 * per page, against other visits to that same page.
 *
 * Document height is measured at every reading and never cached at load. That
 * is the lazy-loading trap GA4 is known for: images and deferred content grow
 * the page after the arithmetic was done, and a cached height reports someone
 * as having finished an article they are a third of the way through.
 */

/** The share of a page that counts as having read it. */
export const READ_THRESHOLD_PCT = 90;

/**
 * Whole percent, 0–100. A document shorter than the viewport is 100: there was
 * nothing below the fold to miss. Nonsense input (a zero-height document mid
 * layout, a negative scroll from rubber-banding) reads 0 rather than throwing —
 * this runs on every scroll event of every page, and must never be the reason a
 * tracker breaks a site.
 */
export function scrollDepthPct(scrollY: number, viewportH: number, documentH: number): number {
  if (!Number.isFinite(scrollY) || !Number.isFinite(viewportH) || !Number.isFinite(documentH)) {
    return 0;
  }
  if (documentH <= 0 || viewportH <= 0) return 0;
  if (documentH <= viewportH) return 100;
  const seen = Math.max(scrollY, 0) + viewportH;
  return Math.max(0, Math.min(100, Math.round((seen / documentH) * 100)));
}

/**
 * The document's height as the tallest thing that claims to know it. Browsers
 * disagree, and the disagreement is not academic: taking only
 * `body.scrollHeight` under-reports a page whose content is on the root
 * element, which would report every reader as having finished.
 */
export function documentHeight(doc: Document): number {
  const body = doc.body;
  const root = doc.documentElement;
  return Math.max(
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    root?.scrollHeight ?? 0,
    root?.offsetHeight ?? 0,
    root?.clientHeight ?? 0,
  );
}
