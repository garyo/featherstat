// @vitest-environment happy-dom
import { SESSION_TIMEOUT_MS } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPEAT_VIEW_MS } from '../repeat.ts';
import { startShim } from './browser.ts';

const TRACKER_URL = 'https://analytics.example.org/matomo.php';

let beacon: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;

/** The production snippet (docs/01), in its real order: track first, configure last. */
function snippet(): unknown[][] {
  return [
    ['disableCookies'],
    ['enableHeartBeatTimer', 15],
    ['trackPageView'],
    ['enableLinkTracking'],
    ['setTrackerUrl', TRACKER_URL],
    ['setSiteId', '2'],
  ];
}

function queue(commands: unknown[][]): void {
  window._paq = commands;
}

function sent(): URLSearchParams[] {
  return beacon.mock.calls.map(([, body]) => new URLSearchParams(String(body)));
}

function anchor(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const element = document.createElement('a');
  element.href = href;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Hello World';
  hide(false); // `visibilityState` is a global property; a hidden test must not leak.
  window._paq = undefined;
  window.__analyticsShim = undefined;
  beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  Reflect.deleteProperty(document, 'prerendering'); // as global as `visibilityState`
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** happy-dom does not prerender; the flag `whenActivated` reads is set by hand. */
function speculating(on: boolean): void {
  Object.defineProperty(document, 'prerendering', { value: on, configurable: true });
}

/** The visitor follows the speculated link. */
function arrive(): void {
  speculating(false);
  document.dispatchEvent(new Event('prerenderingchange'));
}

describe('_paq wiring', () => {
  it('drains the queue the tag left behind and sends the pageview', () => {
    queue(snippet());
    stop = startShim();
    const [pageview] = sent();
    expect(beacon.mock.calls[0]?.[0]).toBe(TRACKER_URL);
    expect(pageview?.get('idsite')).toBe('2');
    expect(pageview?.get('rec')).toBe('1');
    expect(pageview?.get('url')).toBe(location.href);
    expect(pageview?.get('action_name')).toBe('Hello World');
    expect(pageview?.get('res')).toBe(`${screen.width}x${screen.height}`);
    expect(pageview?.get('send_image')).toBe('0');
  });

  it('executes later pushes immediately', () => {
    queue(snippet());
    stop = startShim();
    window._paq?.push(['trackEvent', 'share', 'copy-link']);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]?.get('e_a')).toBe('copy-link');
  });

  it('debugs an unsupported command once and keeps tracking', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    queue(snippet());
    stop = startShim();
    window._paq?.push(['setUserId', 'u1'], ['setUserId', 'u2'], ['trackEvent', 'app', 'ready']);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(2);
  });

  it('restores the queue on teardown', () => {
    queue(snippet());
    startShim()();
    window._paq?.push(['trackPageView']);
    expect(sent()).toHaveLength(1);
    expect(window._paq).toHaveLength(1);
  });

  it('a second install is a no-op: the first shim keeps `_paq` and its heartbeat', () => {
    vi.useFakeTimers();
    queue(snippet());
    stop = startShim();
    const second = startShim(); // page included matomo.js twice
    window._paq?.push(['trackEvent', 'share', 'copy-link']);
    expect(sent()).toHaveLength(2); // pageview + event — dispatched exactly once
    vi.advanceTimersByTime(15_000);
    expect(sent()).toHaveLength(3); // ONE ping per interval, not two
    second(); // tearing down the no-op must not detach the real shim
    window._paq?.push(['trackPageView']);
    expect(sent()).toHaveLength(4);
  });
});

describe('repeated page views', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends one hit when the app announces one navigation twice', () => {
    queue(snippet());
    stop = startShim(); // the snippet's own trackPageView
    vi.advanceTimersByTime(100); // the router's, 100 ms later
    window._paq?.push(['trackPageView']);
    expect(sent()).toHaveLength(1);
  });

  it('sends both when the reader comes back to the same URL later', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(REPEAT_VIEW_MS);
    window._paq?.push(['trackPageView']);
    expect(sent()).toHaveLength(2);
  });

  /**
   * A reader who idles past the session timeout and reloads starts a NEW visit.
   * If the guard swallowed that page view the visit would hold heartbeats and
   * nothing else — the ghost visit `bbd4427` removed (repeat.ts).
   */
  it('never swallows the page view that starts the next visit', () => {
    queue(snippet());
    stop = startShim();
    window.dispatchEvent(new Event('blur')); // away: nothing is sent while blurred
    vi.advanceTimersByTime(SESSION_TIMEOUT_MS + 60_000);
    window.dispatchEvent(new Event('focus'));
    window._paq?.push(['trackPageView']);
    const views = sent().filter((params) => !params.has('ping'));
    expect(views).toHaveLength(2);
    expect(views[1]?.get('url')).toBe(location.href);
  });
});

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('pings on the configured interval while the page has focus', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(15_000);
    const ping = sent()[1];
    expect(ping?.get('ping')).toBe('1');
    expect(ping?.get('url')).toBe(location.href);
    expect(ping?.has('action_name')).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(sent()).toHaveLength(3);
  });

  it('stops while the page is blurred and resumes on focus', () => {
    queue(snippet());
    stop = startShim();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(60_000);
    expect(sent()).toHaveLength(1);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(15_000);
    expect(sent()).toHaveLength(2);
  });

  it('stops while the tab is hidden', () => {
    queue(snippet());
    stop = startShim();
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(30_000);
    expect(sent()).toHaveLength(1);
    hide(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(15_000);
    expect(sent()).toHaveLength(2);
  });

  it('stops on teardown', () => {
    queue(snippet());
    stop = startShim();
    stop();
    stop = undefined;
    vi.advanceTimersByTime(60_000);
    expect(sent()).toHaveLength(1);
  });
});

describe('exit ping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** The read that prompted this: ~30 s on a page whose last heartbeat was at 15 s. */
  it('credits the tail of a read the heartbeat never reached', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(15_000); // pageview at 0, ping at 15
    expect(sent()).toHaveLength(2);
    vi.advanceTimersByTime(15_000 - 1); // leaves at ~30 s, before the next tick
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    const exit = sent()[2];
    expect(exit?.get('ping')).toBe('1');
    expect(exit?.get('url')).toBe(location.href);
  });

  it('fires once, not again for the pagehide that follows', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(5_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(2);
  });

  // Mobile Safari often skips visibilitychange on the way out.
  it('still fires when only pagehide arrives', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(2);
  });

  it('credits nothing when a hit just went out', () => {
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(15_000);
    hide(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent()).toHaveLength(2); // the ping, and no exit ping on its heels
  });

  it('refuses to credit a long-backgrounded tab for its absence', () => {
    queue(snippet());
    stop = startShim();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(300_000); // blurred, so the heartbeat sent nothing
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(1);
  });

  it('stays silent for a tag that never asked for engagement timing', () => {
    queue([['trackPageView'], ['setTrackerUrl', TRACKER_URL], ['setSiteId', '2']]);
    stop = startShim();
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(1);
  });

  // Found live: hiding, then closing the tab seconds later, used to send a
  // second exit ping — banking time the visitor spent elsewhere as attention.
  it('reports one departure, however many ways the page announces it', () => {
    queue(snippet());
    stop = startShim();
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
    queue(snippet());
    stop = startShim();
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
    queue(snippet());
    stop = startShim();
    vi.advanceTimersByTime(5_000);
    stop();
    stop = undefined;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent()).toHaveLength(1);
  });
});

describe('link tracking', () => {
  beforeEach(() => {
    // happy-dom would follow the link and move `location` out from under the test.
    document.addEventListener('click', preventNavigation);
    queue(snippet());
    stop = startShim();
  });

  afterEach(() => {
    document.removeEventListener('click', preventNavigation);
  });

  it('classifies a different host as an outlink', () => {
    anchor('https://github.com/garyo/pcons').click();
    expect(sent()[1]?.get('link')).toBe('https://github.com/garyo/pcons');
    expect(sent()[1]?.get('url')).toBe(location.href);
  });

  it('classifies a file extension as a download, on either host', () => {
    anchor(`${location.origin}/dist/pcons-2.1.tar.gz`).click();
    expect(sent()[1]?.get('download')).toBe(`${location.origin}/dist/pcons-2.1.tar.gz`);
    anchor('https://cdn.example.net/report.pdf').click();
    expect(sent()[2]?.get('download')).toBe('https://cdn.example.net/report.pdf');
  });

  it('honors the download attribute for extensionless URLs', () => {
    anchor(`${location.origin}/export`, { download: 'export' }).click();
    expect(sent()[1]?.get('download')).toBe(`${location.origin}/export`);
  });

  it('ignores internal navigation and non-http schemes', () => {
    anchor(`${location.origin}/about`).click();
    anchor('mailto:garyo@example.com').click();
    anchor('#section').click();
    expect(sent()).toHaveLength(1);
  });

  it('finds the anchor from a nested click target', () => {
    const link = anchor('https://github.com/garyo/pcons');
    const span = document.createElement('span');
    link.append(span);
    span.click();
    expect(sent()[1]?.get('link')).toBe('https://github.com/garyo/pcons');
  });
});

describe('delivery', () => {
  it('falls back to fetch with keepalive when sendBeacon refuses', () => {
    beacon.mockReturnValue(false);
    const fetched = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal('fetch', fetched);
    queue(snippet());
    stop = startShim();
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, options] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TRACKER_URL);
    expect(options.keepalive).toBe(true);
    expect(options.method).toBe('POST');
    expect(new URLSearchParams(String(options.body)).get('idsite')).toBe('2');
    vi.unstubAllGlobals();
  });

  it('survives a sendBeacon that throws', () => {
    beacon.mockImplementation(() => {
      throw new Error('payload too large');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response())),
    );
    queue(snippet());
    expect(() => {
      stop = startShim();
    }).not.toThrow();
    vi.unstubAllGlobals();
  });
});

function preventNavigation(event: Event): void {
  event.preventDefault();
}

/** happy-dom derives `visibilityState`; the shim only reads it, so overriding is enough. */
function hide(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
}

describe('prerendering (prerender.ts)', () => {
  it('sends nothing for a tag that ran only because the page was speculated on', () => {
    speculating(true);
    queue(snippet());
    stop = startShim();
    expect(sent()).toEqual([]);
  });

  it('drains the tag in its original order when the visitor arrives', () => {
    speculating(true);
    queue(snippet());
    stop = startShim();
    arrive();
    const [pageview] = sent();
    expect(beacon.mock.calls[0]?.[0]).toBe(TRACKER_URL);
    expect(pageview?.get('idsite')).toBe('2');
    expect(pageview?.get('url')).toBe(location.href);
  });

  // The array is the tag's own; while speculating it keeps its native `push`, so
  // commands land in it and are drained on arrival rather than lost.
  it('keeps commands pushed during the speculation', () => {
    speculating(true);
    queue(snippet());
    stop = startShim();
    window._paq?.push(['trackEvent', 'globe', 'rotate']);
    expect(sent()).toEqual([]);
    arrive();
    expect(sent().some((hit) => hit.get('e_a') === 'rotate')).toBe(true);
  });

  it('never sends for a prerender torn down before the visitor arrives', () => {
    speculating(true);
    queue(snippet());
    stop = startShim();
    stop();
    stop = undefined;
    arrive();
    expect(sent()).toEqual([]);
  });
});
