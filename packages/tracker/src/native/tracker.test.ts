// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
