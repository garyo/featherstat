import type { RealtimeHit, RealtimeSnapshot, VersionTick } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveStream,
  createRevalidator,
  type EventSourceLike,
  REVALIDATE_DEBOUNCE_MS,
} from './live.ts';

/** Stands in for the browser's EventSource: records listeners, replays frames on demand. */
class FakeEventSource implements EventSourceLike {
  static opened: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const frame = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(frame as MessageEvent<string>);
    }
  }
}

const open = (url: string): EventSourceLike => new FakeEventSource(url);
const latest = (): FakeEventSource => {
  const source = FakeEventSource.opened.at(-1);
  if (source === undefined) throw new Error('no stream was opened');
  return source;
};

const hit: RealtimeHit = {
  siteId: 4,
  ts: 1_770_000_000_000,
  type: 'pageview',
  visitor: { name: 'Nimble Narwhal', color: 1, ref: 'ref-n' },
  path: '/timeline',
};
const tick: VersionTick = { siteId: 4, version: 12 };
const snapshot: RealtimeSnapshot = { active: { 4: 2 }, recent: [], visitors: [] };

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live stream', () => {
  it('scopes the subscription to the requested sites', () => {
    createLiveStream({ open, sites: 4 });
    expect(latest().url).toBe('/api/realtime?sites=4');

    createLiveStream({ open });
    expect(latest().url).toBe('/api/realtime?sites=all');
  });

  it('delivers hit, active and version frames as parsed payloads', () => {
    const stream = createLiveStream({ open });
    const hits: RealtimeHit[] = [];
    const active: Array<Record<number, number>> = [];
    const versions: VersionTick[] = [];
    stream.on('hit', (payload) => hits.push(payload));
    stream.on('active', (payload) => active.push(payload.active));
    stream.on('version', (payload) => versions.push(payload));

    latest().emit('hit', hit);
    latest().emit('active', { active: { 4: 7 } });
    latest().emit('version', tick);

    expect(hits).toEqual([hit]);
    expect(active).toEqual([{ 4: 7 }]);
    expect(versions).toEqual([tick]);
  });

  it('stops delivering after unsubscribe and ignores unparseable frames', () => {
    const stream = createLiveStream({ open });
    const seen: RealtimeHit[] = [];
    const off = stream.on('hit', (payload) => seen.push(payload));

    latest().emit('hit', '{ truncated');
    latest().emit('hit', hit);
    off();
    latest().emit('hit', hit);

    expect(seen).toEqual([hit]);
  });

  it('reconnects with a backoff that resets once a connection proves steady', () => {
    createLiveStream({ open, minRetryMs: 1_000, maxRetryMs: 8_000, steadyMs: 2_000 });
    const first = latest();

    first.emit('error', {});
    expect(first.closed).toBe(true);
    expect(FakeEventSource.opened).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(FakeEventSource.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.opened).toHaveLength(2);

    latest().emit('error', {});
    vi.advanceTimersByTime(1_999);
    expect(FakeEventSource.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.opened).toHaveLength(3);

    // Survives the steady window: the ladder starts over on the next failure.
    latest().emit('open', {});
    vi.advanceTimersByTime(2_000);
    latest().emit('error', {});
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.opened).toHaveLength(4);
  });

  it('keeps backing off when connections open and then die young', () => {
    createLiveStream({ open, minRetryMs: 1_000, maxRetryMs: 8_000, steadyMs: 2_000 });

    // Each accept-then-die cycle: `open` fires, then the stream drops within 1 s.
    latest().emit('open', {});
    latest().emit('error', {});
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.opened).toHaveLength(2);

    latest().emit('open', {});
    latest().emit('error', {});
    vi.advanceTimersByTime(1_999);
    expect(FakeEventSource.opened).toHaveLength(2); // 2nd retry waits the doubled delay
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.opened).toHaveLength(3);

    latest().emit('open', {});
    latest().emit('error', {});
    vi.advanceTimersByTime(3_999);
    expect(FakeEventSource.opened).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.opened).toHaveLength(4);
  });

  it('caps the backoff', () => {
    createLiveStream({ open, minRetryMs: 1_000, maxRetryMs: 2_000 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      latest().emit('error', {});
      vi.advanceTimersByTime(2_000);
    }
    expect(FakeEventSource.opened).toHaveLength(6);
  });

  it('declares a silent connection dead and reconnects', () => {
    const stream = createLiveStream({ open, minRetryMs: 1_000, staleMs: 10_000 });
    const statuses: boolean[] = [];
    stream.on('status', (payload) => statuses.push(payload.connected));
    latest().emit('snapshot', snapshot);

    // Frames keep resetting the deadline …
    vi.advanceTimersByTime(9_000);
    latest().emit('active', { active: {} });
    vi.advanceTimersByTime(9_999);
    expect(FakeEventSource.opened).toHaveLength(1);

    // … but silence past it means the socket is dead, even without an `error`.
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    expect(statuses).toEqual([false]);
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.opened).toHaveLength(2);

    latest().emit('snapshot', snapshot);
    expect(statuses).toEqual([false, true]);
  });

  it('synthesizes a reconnect event for every snapshot after the first', () => {
    const stream = createLiveStream({ open, minRetryMs: 1_000 });
    let reconnects = 0;
    let snapshots = 0;
    stream.on('reconnect', () => reconnects++);
    stream.on('snapshot', () => snapshots++);

    latest().emit('snapshot', snapshot);
    expect(snapshots).toBe(1);
    expect(reconnects).toBe(0);

    latest().emit('error', {});
    vi.advanceTimersByTime(1_000);
    latest().emit('snapshot', snapshot);
    expect(snapshots).toBe(2);
    expect(reconnects).toBe(1);
  });

  it('closing stops the retry schedule and the watchdog', () => {
    const stream = createLiveStream({ open, minRetryMs: 1_000, staleMs: 10_000 });
    latest().emit('error', {});
    stream.close();

    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.opened).toHaveLength(1);
  });
});

describe('revalidator', () => {
  it('coalesces a burst of version ticks into one re-query', () => {
    const stream = createLiveStream({ open });
    let calls = 0;
    createRevalidator(stream, () => calls++, { site: () => 4 });

    latest().emit('version', tick);
    vi.advanceTimersByTime(1_000);
    latest().emit('version', { siteId: 4, version: 13 });
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS - 1_000 - 1);
    expect(calls).toBe(0);

    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);

    // The window reopens, so a site that never goes quiet still refreshes on cadence.
    latest().emit('version', { siteId: 4, version: 14 });
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(2);
  });

  it('ignores ticks for sites the view is not showing', () => {
    const stream = createLiveStream({ open });
    let calls = 0;
    let site: number | 'all' = 4;
    createRevalidator(stream, () => calls++, { site: () => site });

    latest().emit('version', { siteId: 2, version: 3 });
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(0);

    // The overview watches every site, and the scope is read per tick.
    site = 'all';
    latest().emit('version', { siteId: 2, version: 4 });
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(1);
  });

  it('drops an armed window when the view state changed underneath it', () => {
    const stream = createLiveStream({ open });
    let calls = 0;
    let key = 'site4/30d';
    createRevalidator(stream, () => calls++, { site: () => 4, key: () => key });

    latest().emit('version', tick);
    key = 'site4/7d'; // the user changed range mid-window; that change runs its own batch
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(0);

    latest().emit('version', { siteId: 4, version: 13 });
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(1);
  });

  it('treats a reconnection as a tick — missed versions must not strand the view', () => {
    const stream = createLiveStream({ open, minRetryMs: 1_000 });
    let calls = 0;
    createRevalidator(stream, () => calls++, { site: () => 4 });

    latest().emit('snapshot', snapshot);
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(0); // the first snapshot is the connect the view just fetched for

    latest().emit('error', {});
    vi.advanceTimersByTime(1_000);
    latest().emit('snapshot', snapshot);
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    expect(calls).toBe(1);
  });

  it('stops on unsubscribe, including a window already open', () => {
    const stream = createLiveStream({ open });
    let calls = 0;
    const stop = createRevalidator(stream, () => calls++, { site: () => 'all' });

    latest().emit('version', tick);
    stop();
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);

    latest().emit('version', tick);
    vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    expect(calls).toBe(0);
  });
});
