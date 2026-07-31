// @vitest-environment happy-dom
import { SESSION_TIMEOUT_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPEAT_VIEW_MS } from '../repeat.ts';
import { init, page, track } from './tracker.ts';

const ENDPOINT = 'https://analytics.example.org/api/collect';

interface Payload {
  site: number;
  hits: Record<string, unknown>[];
}

let beacon: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;

function start(config: Partial<Parameters<typeof init>[0]> = {}): void {
  stop = init({ site: 4, endpoint: ENDPOINT, ...config });
}

function sent(): Record<string, unknown>[] {
  return beacon.mock.calls.flatMap(([, body]) => (JSON.parse(String(body)) as Payload).hits);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Cambrian';
  hide(false); // `visibilityState` is a global property; a hidden test must not leak.
  beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pageviews', () => {
  it('records one on init, addressed to the configured site and endpoint', () => {
    start();
    expect(beacon.mock.calls[0]?.[0]).toBe(ENDPOINT);
    const payload = JSON.parse(String(beacon.mock.calls[0]?.[1])) as Payload;
    expect(payload.site).toBe(4);
    expect(payload.hits).toEqual([
      {
        type: 'pageview',
        url: location.href,
        title: 'Cambrian',
        screen: `${screen.width}x${screen.height}`,
        lang: navigator.language,
      },
    ]);
  });

  it('defaults the endpoint to /api/collect', () => {
    stop = init({ site: 4 });
    expect(beacon.mock.calls[0]?.[0]).toBe('/api/collect');
  });

  it('follows history navigation, carrying the previous view as the referrer', () => {
    start();
    const entry = location.href;
    history.pushState({}, '', '/era/ordovician');
    expect(sent()[1]).toMatchObject({ type: 'pageview', url: location.href, referrer: entry });
    const ordovician = location.href;
    history.replaceState({}, '', '/era/silurian');
    expect(sent()[2]).toMatchObject({ url: location.href, referrer: ordovician });
  });

  it('ignores a history call that does not change the URL', () => {
    start();
    history.replaceState({ step: 1 }, '', location.href);
    expect(sent()).toHaveLength(1);
  });

  it('opts out of auto pageviews, leaving page() to the app', () => {
    start({ autoPageviews: false });
    expect(sent()).toHaveLength(0);
    history.pushState({}, '', '/era/devonian');
    expect(sent()).toHaveLength(0);
    page();
    expect(sent()[0]).toMatchObject({ type: 'pageview', url: location.href });
  });

  it('restores the history methods on teardown', () => {
    const original = history.pushState;
    start();
    expect(history.pushState).not.toBe(original);
    stop?.();
    stop = undefined;
    expect(history.pushState).toBe(original);
  });
});

describe('repeated page views', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends one hit when the router and the app both announce a navigation', () => {
    start(); // the history hook's pageview
    vi.advanceTimersByTime(100);
    page(); // and the app's, for the same route
    expect(sent()).toHaveLength(1);
  });

  it('sends both when the reader comes back to the same URL later', () => {
    start();
    vi.advanceTimersByTime(REPEAT_VIEW_MS);
    page();
    expect(sent()).toHaveLength(2);
  });

  it('keeps the referrer chain: a suppressed repeat is not the next referrer', () => {
    start({ autoPageviews: false });
    const entry = location.href;
    page(entry);
    page(entry); // the double-fire
    vi.advanceTimersByTime(2_000);
    page('https://deep-timeline.org/era/cambrian');
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({
      url: 'https://deep-timeline.org/era/cambrian',
      referrer: entry,
    });
  });

  /**
   * Past the session timeout a page view starts a NEW visit. A guard that
   * swallowed it would leave that visit with nothing but heartbeats in it — the
   * ghost visit `bbd4427` removed, rebuilt from the other end (repeat.ts).
   */
  it('never swallows the page view that starts the next visit', () => {
    start();
    window.dispatchEvent(new Event('blur')); // idle: no pings while blurred
    vi.advanceTimersByTime(SESSION_TIMEOUT_MS + 60_000);
    page();
    expect(sent().filter((hit) => hit.type === 'pageview')).toHaveLength(2);
  });

  it('leaves events and links alone', () => {
    start();
    track('rotate', { category: 'globe' });
    track('rotate', { category: 'globe' });
    expect(sent()).toHaveLength(3);
  });
});

describe('events and links', () => {
  it('sends track() as an event with a default category', () => {
    start();
    track('copy-link');
    track('signup', { category: 'account', name: 'pro', value: 2.5 });
    expect(sent()[1]).toEqual({
      type: 'event',
      url: location.href,
      category: 'custom',
      action: 'copy-link',
    });
    expect(sent()[2]).toMatchObject({ category: 'account', action: 'signup', value: 2.5 });
  });

  it('classifies outlinks and downloads from clicks', () => {
    start();
    document.addEventListener('click', (event) => event.preventDefault());
    const link = document.createElement('a');
    link.href = 'https://github.com/garyo/pcons';
    document.body.append(link);
    link.click();
    expect(sent()[1]).toMatchObject({
      type: 'outlink',
      targetUrl: 'https://github.com/garyo/pcons',
      url: location.href,
    });
    link.href = `${location.origin}/paper.pdf`;
    link.click();
    expect(sent()[2]).toMatchObject({
      type: 'download',
      targetUrl: `${location.origin}/paper.pdf`,
    });
  });

  it('drops hits once the tracker is stopped', () => {
    start();
    stop?.();
    stop = undefined;
    track('after-stop');
    expect(sent()).toHaveLength(1);
  });
});

describe('engagement pings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('pings on the heartbeat interval while focused', () => {
    start();
    vi.advanceTimersByTime(15_000);
    expect(sent()[1]).toEqual({ type: 'ping', url: location.href });
  });

  it('pauses when blurred', () => {
    start();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(45_000);
    expect(sent()).toHaveLength(1);
  });

  it('pauses after the idle window and resumes on the next input', () => {
    start();
    vi.advanceTimersByTime(45_000); // three pings, all inside the 60 s idle window
    expect(sent()).toHaveLength(4);
    vi.advanceTimersByTime(30_000); // idle now: 75 s without input
    expect(sent()).toHaveLength(4);
    document.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(15_000);
    expect(sent()).toHaveLength(5);
  });

  it('counts a keypress, a scroll and a touch as input too', () => {
    for (const name of ['keydown', 'scroll', 'touchstart']) {
      start();
      vi.advanceTimersByTime(75_000);
      const idle = sent().length;
      document.dispatchEvent(new Event(name));
      vi.advanceTimersByTime(15_000);
      expect(sent().length, name).toBe(idle + 1);
      stop?.();
      beacon.mockClear();
    }
    stop = undefined;
  });
});

describe('exit ping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** The read that prompted this: ~30 s on a page whose last heartbeat was at 15 s. */
  it('credits the tail of a read the heartbeat never reached', () => {
    start();
    vi.advanceTimersByTime(15_000); // pageview at 0, ping at 15
    expect(sent()).toHaveLength(2);
    vi.advanceTimersByTime(15_000 - 1); // leaves at ~30 s, before the next tick
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()[2]).toEqual({ type: 'ping', url: location.href });
  });

  it('fires once, not again for the pagehide that follows', () => {
    start();
    vi.advanceTimersByTime(5_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(2);
  });

  // Mobile Safari often skips visibilitychange on the way out.
  it('still fires when only pagehide arrives', () => {
    start();
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(2);
  });

  it('credits nothing when a hit just went out', () => {
    start();
    vi.advanceTimersByTime(15_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(2);
  });

  it('refuses to credit an idle tab for its absence', () => {
    start();
    vi.advanceTimersByTime(300_000); // idle past 60 s, so the heartbeat stopped
    const idle = sent().length;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(idle);
  });

  it('scales its window with a configured heartbeat', () => {
    start({ heartbeatSeconds: 30 });
    vi.advanceTimersByTime(45_000); // one ping at 30 s, 15 s of tail
    expect(sent()).toHaveLength(2);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(3);
  });

  // Found live: hiding, then closing the tab seconds later, used to send a
  // second exit ping — banking time the visitor spent elsewhere as attention.
  it('reports one departure, however many ways the page announces it', () => {
    start();
    vi.advanceTimersByTime(5_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toHaveLength(2);
    vi.advanceTimersByTime(3_000); // hidden all the while — not reading
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toHaveLength(2);
  });

  it('reports the next departure once the reader has come back', () => {
    start();
    vi.advanceTimersByTime(5_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toHaveLength(2);
    hide(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toHaveLength(3); // one page view, one exit ping per departure
  });

  it('stops on teardown', () => {
    start();
    vi.advanceTimersByTime(5_000);
    stop?.();
    stop = undefined;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(1);
  });
});

function hide(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
}

describe('scroll depth', () => {
  /** happy-dom has no layout, so the page's geometry is stated outright. */
  const layout = (viewportH: number, documentH: number, scrollY = 0): void => {
    Object.defineProperty(window, 'innerHeight', { value: viewportH, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: documentH,
      configurable: true,
    });
  };
  const scrollTo = (y: number): void => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20); // let the rAF throttle land
  };
  const pings = (): Record<string, unknown>[] => sent().filter((hit) => hit.type === 'ping');

  beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom has no rAF under fake timers; a timeout is the same shape here.
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      setTimeout(() => fn(0), 0);
      return 0;
    });
  });

  it('reports the deepest point reached, not the last one', () => {
    layout(1_000, 4_000);
    start();
    scrollTo(3_000); // 100%
    scrollTo(0); // back to the top — the page was still read to the end
    vi.advanceTimersByTime(15_000);
    expect(pings()[0]?.scroll).toBe(100);
  });

  it('carries the running depth on every ping', () => {
    layout(1_000, 4_000);
    start();
    vi.advanceTimersByTime(15_000);
    expect(pings()[0]?.scroll).toBe(25); // the viewport's share, unscrolled
    scrollTo(1_000);
    vi.advanceTimersByTime(15_000);
    expect(pings()[1]?.scroll).toBe(50);
  });

  // A reading of 0 means the page could not be measured, not that nobody saw
  // anything — sending it would fabricate a bounce off the header.
  it('sends no reading at all for a page it could not measure', () => {
    layout(0, 0);
    start();
    vi.advanceTimersByTime(15_000);
    expect(pings()[0]).not.toHaveProperty('scroll');
  });

  it('reports passing the read threshold once, as an ordinary event', () => {
    layout(1_000, 4_000);
    start();
    scrollTo(2_600); // 90%
    const reads = sent().filter((hit) => hit.type === 'event');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ category: 'scroll', action: 'read', url: location.href });
    scrollTo(3_000); // deeper still — the milestone is not news twice
    scrollTo(3_500);
    expect(sent().filter((hit) => hit.type === 'event')).toHaveLength(1);
  });

  it('starts a new page at nothing, so an SPA route does not inherit a depth', () => {
    layout(1_000, 4_000);
    start();
    scrollTo(3_000); // read the first page to the end
    expect(sent().filter((hit) => hit.type === 'event')).toHaveLength(1);
    layout(1_000, 8_000, 0);
    page('https://deep-timeline.org/era/ordovician');
    vi.advanceTimersByTime(15_000);
    // 12.5% of the new page, and its own read event still to be earned.
    expect(pings().at(-1)?.scroll).toBe(13);
    expect(sent().filter((hit) => hit.type === 'event')).toHaveLength(1);
  });

  it('notices a page that grew after load without anyone scrolling', () => {
    layout(1_000, 1_000); // fits the viewport: fully read
    start();
    vi.advanceTimersByTime(15_000);
    expect(pings()[0]?.scroll).toBe(100);
    layout(1_000, 5_000); // lazy content landed; the end moved away
    vi.advanceTimersByTime(15_000);
    // Still 100: depth is a high-water mark, and they HAD seen the whole page.
    expect(pings()[1]?.scroll).toBe(100);
  });
});
