/**
 * The same URL announced twice for one navigation, shared by both trackers.
 *
 * SPA routers do this: the page installs the tracker once and the app then calls
 * `trackPageView` from two places for a single route change (docs/04 § 1). In
 * production the two hits arrive 0–112 ms apart, which is not a reload — on one
 * app it was 19 % of its page views, and its journeys read `/app → /app → /app`
 * for what the reader experienced as one navigation.
 *
 * The window is deliberately short and, more importantly, deliberately BOUNDED.
 * Short, because a genuine reload is a real second view: 1 s is an order of
 * magnitude above every double-fire measured and below any human reload.
 * Bounded, because a guard that reached as far as the session timeout could
 * swallow the page view that legitimately STARTS the next visit — a reader who
 * idles past the 30-minute timeout and then reloads begins a new visit, and a
 * suppressed hit there would leave that visit with no page view in it. That is
 * the heartbeat-only ghost visit `bbd4427` removed, rebuilt from the other end.
 * `repeat.test.ts` pins the window far below `SESSION_TIMEOUT_MS` so it cannot
 * happen, and both trackers assert the behaviour end to end.
 */
export const REPEAT_VIEW_MS = 1_000;

/**
 * Whether a page view of `url` at `at` repeats the one already recorded. A clock
 * that jumps backwards reads as "not a repeat" rather than parking the guard on.
 */
export function isRepeatView(url: string, at: number, lastUrl: string, lastAt: number): boolean {
  const since = at - lastAt;
  return url === lastUrl && since >= 0 && since < REPEAT_VIEW_MS;
}
