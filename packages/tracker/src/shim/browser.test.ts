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
  window._paq = undefined;
  window.__analyticsShim = undefined;
  beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
