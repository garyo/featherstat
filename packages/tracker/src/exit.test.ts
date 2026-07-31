import { PING_CLAMP_MS } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { EXIT_MAX_HEARTBEATS, EXIT_MIN_GAP_MS, isExitPingWorthwhile } from './exit.ts';

const HEARTBEAT_MS = 15_000;
const worthwhile = (gap: number, heartbeat = HEARTBEAT_MS): boolean =>
  isExitPingWorthwhile(1_000_000, 1_000_000 + gap, heartbeat);

describe('isExitPingWorthwhile', () => {
  it('credits the tail of a read the heartbeat never reached', () => {
    // The case that prompted this: ~30 s on a page, last ping at 14 s.
    expect(worthwhile(16_000)).toBe(true);
  });

  it('is silent before anything has been tracked', () => {
    expect(isExitPingWorthwhile(0, 5_000, HEARTBEAT_MS)).toBe(false);
  });

  it('is silent when a hit just went out', () => {
    expect(worthwhile(0)).toBe(false);
    expect(worthwhile(EXIT_MIN_GAP_MS - 1)).toBe(false);
    expect(worthwhile(EXIT_MIN_GAP_MS)).toBe(true);
  });

  // Sending the exit ping updates the last-hit time, so the pagehide backstop
  // that follows visibilitychange by a few ms falls under the floor. That is
  // the whole dedupe — no second flag to keep in sync.
  it('suppresses the pagehide backstop that follows a hide by milliseconds', () => {
    expect(worthwhile(3)).toBe(false);
  });

  it('refuses to credit silence as attention', () => {
    const ceiling = HEARTBEAT_MS * EXIT_MAX_HEARTBEATS;
    expect(worthwhile(ceiling)).toBe(true);
    expect(worthwhile(ceiling + 1)).toBe(false);
    // A tab backgrounded for five minutes and then closed earns nothing.
    expect(worthwhile(300_000)).toBe(false);
  });

  it('scales with the configured heartbeat rather than assuming 15 s', () => {
    expect(worthwhile(16_000, 5_000)).toBe(false);
    expect(worthwhile(16_000, 30_000)).toBe(true);
  });

  it('reads a backwards clock as not worthwhile', () => {
    expect(worthwhile(-5_000)).toBe(false);
  });

  // Our ceiling is the wider of the two, so the sessionizer's clamp is what
  // actually bounds the credit: an honest 25 s tail still books only 20 s.
  // Both bounds are load-bearing — ours rejects absence, its truncates.
  it('leaves the sessionizer clamp as the real ceiling on credit', () => {
    expect(HEARTBEAT_MS * EXIT_MAX_HEARTBEATS).toBeGreaterThan(PING_CLAMP_MS);
  });
});
