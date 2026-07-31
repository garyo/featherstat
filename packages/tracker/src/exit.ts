/**
 * Whether leaving the page is worth a final `ping`.
 *
 * Engagement accrues between hits (`sessionizer.ts`: each hit credits the gap
 * since the last one, clamped at `PING_CLAMP_MS`), so a session is only ever
 * credited up to its *last* hit. With a 15 s heartbeat and nothing sent at the
 * end, every visit silently loses its final partial interval — uniformly
 * distributed on [0, heartbeat), so 7.5 s on average, which is a quarter of a
 * 30-second read. An exit ping closes that gap.
 *
 * Both bounds exist to keep the ping honest rather than merely generous:
 *
 * - Below `EXIT_MIN_GAP_MS` there is nothing to credit — a visitor who leaves
 *   just after a heartbeat would cost a beacon to record a few hundred ms.
 * - Past `EXIT_MAX_HEARTBEATS` intervals the heartbeat had already stopped
 *   (blurred, hidden, or idle), so the gap is absence, not attention, and
 *   crediting it would hand a backgrounded tab a full clamp of engagement it
 *   never earned. Two intervals rather than one because the tick before
 *   leaving is often skipped by the very blur that precedes the exit.
 */

/** Below this, leaving is not worth a beacon. */
export const EXIT_MIN_GAP_MS = 1_000;

/** Past this many heartbeat intervals of silence, the gap is absence. */
export const EXIT_MAX_HEARTBEATS = 2;

export function isExitPingWorthwhile(lastHitAt: number, now: number, heartbeatMs: number): boolean {
  if (lastHitAt <= 0) return false; // Nothing has been tracked yet.
  const gap = now - lastHitAt;
  return gap >= EXIT_MIN_GAP_MS && gap <= heartbeatMs * EXIT_MAX_HEARTBEATS;
}
