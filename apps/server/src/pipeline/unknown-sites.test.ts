import { describe, expect, it } from 'vitest';
import { UNKNOWN_SITE_REFS, UnknownSiteTally } from './unknown-sites.ts';

function clocked(): { tally: UnknownSiteTally; tick: () => void } {
  let now = 1_000;
  const tally = new UnknownSiteTally(() => now);
  return { tally, tick: () => (now += 1_000) };
}

describe('UnknownSiteTally', () => {
  it('starts at zero, stamped with when it started', () => {
    expect(clocked().tally.report()).toEqual({ since: 1_000, hits: 0, recent: [] });
  });

  it('sums hits per reference and lists the most recently seen first', () => {
    const { tally, tick } = clocked();
    tally.record('oberbruner.com', 2);
    tick();
    tally.record(99, 1);
    tick();
    tally.record('oberbruner.com', 3);
    expect(tally.report()).toEqual({
      since: 1_000,
      hits: 6,
      recent: [
        { ref: 'oberbruner.com', hits: 5, lastSeen: 3_000 },
        { ref: '99', hits: 1, lastSeen: 2_000 },
      ],
    });
  });

  // A forged beacon can name anything: the list stays bounded, the total stays true.
  it('forgets the longest-unseen reference past the cap, but never its hits', () => {
    const { tally, tick } = clocked();
    for (let i = 0; i <= UNKNOWN_SITE_REFS; i++) {
      tally.record(`site-${i}.test`, 1);
      tick();
    }
    const report = tally.report();
    expect(report.hits).toBe(UNKNOWN_SITE_REFS + 1);
    expect(report.recent).toHaveLength(UNKNOWN_SITE_REFS);
    expect(report.recent.map((entry) => entry.ref)).not.toContain('site-0.test');
    expect(report.recent[0]?.ref).toBe(`site-${UNKNOWN_SITE_REFS}.test`);
  });

  it('ignores an envelope that carried no hits', () => {
    const { tally } = clocked();
    tally.record('empty.test', 0);
    expect(tally.report().recent).toEqual([]);
  });
});
