import { SESSION_TIMEOUT_MS } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { isRepeatView, REPEAT_VIEW_MS } from './repeat.ts';

const URL = 'https://pelorus-nav.com/app';

describe('repeat-view guard', () => {
  it('catches the double-fire and leaves a later view alone', () => {
    expect(isRepeatView(URL, 100, URL, 0)).toBe(true);
    expect(isRepeatView(URL, 112, URL, 0)).toBe(true);
    expect(isRepeatView(URL, REPEAT_VIEW_MS, URL, 0)).toBe(false);
    expect(isRepeatView(URL, 60_000, URL, 0)).toBe(false);
  });

  it('never crosses URLs — a fast navigation is not a repeat', () => {
    expect(isRepeatView('https://pelorus-nav.com/app/route', 40, URL, 0)).toBe(false);
  });

  /**
   * The bound that makes a pageview-less visit impossible.
   *
   * A page view starts a NEW visit exactly when more than `SESSION_TIMEOUT_MS`
   * has passed since the visitor's last hit (docs/03). The guard only ever drops
   * a view within `REPEAT_VIEW_MS` of the previous one it let through, so as
   * long as that window is far below the timeout, a dropped view always lands
   * inside a visit the view it repeats already put a page view into. Widen this
   * to session length and the reader who idles 40 minutes and reloads opens a
   * visit with nothing in it — the heartbeat-only ghost visit, from the other
   * end.
   */
  it('cannot swallow a view that would start a new visit', () => {
    expect(REPEAT_VIEW_MS).toBeLessThan(SESSION_TIMEOUT_MS / 60);
    expect(isRepeatView(URL, SESSION_TIMEOUT_MS + 1, URL, 0)).toBe(false);
  });

  it('reads a backwards clock jump as a fresh view, never as a repeat', () => {
    // Otherwise the guard parks on that URL until the clock catches up.
    expect(isRepeatView(URL, 0, URL, 3_600_000)).toBe(false);
  });
});
