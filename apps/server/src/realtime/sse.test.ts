import {
  ACTIVE_TICK_MS,
  ACTIVE_WINDOW_MS,
  BATCH_INTERVAL_MS,
  HEARTBEAT_MS,
  type RealtimeHit,
  type RealtimeSnapshot,
} from '@analytics/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA, event, openTestDb, T0 } from '../../test/rows.ts';
import type { Db } from '../db/index.ts';
import { createApp } from '../index.ts';
import type { GeoProvider } from '../pipeline/geo.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createRealtimeHub, type RealtimeHub } from './hub.ts';
import { MAX_QUEUED_FRAMES } from './sse.ts';

/** RFC 5737 documentation address — the only kind this repo may hold (invariant 3). */
const CLIENT_IP = '203.0.113.5';
/** A Matomo `_id`: client-supplied identity, and just as unwelcome on the wire. */
const MATOMO_ID = '00112233445566aa';

const BOSTON: GeoProvider = {
  lookup: () => ({
    country: 'US',
    region: 'Massachusetts',
    city: 'Boston',
    lat: 42.36,
    lon: -71.06,
  }),
};

let db: Db;
let pipeline: Pipeline;
let hub: RealtimeHub;
let app: Hono;
let open: Frames[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openTestDb(2);
  pipeline = createPipeline(db, { geo: BOSTON });
  hub = createRealtimeHub(db);
  pipeline.onHit((row) => hub.record(row));
  pipeline.onFlush((summary) => hub.recordFlush(summary));
  app = createApp({ sink: pipeline.sink, db, hub });
  open = [];
});

afterEach(async () => {
  for (const frames of open) await frames.close();
  pipeline.shutdown();
  db.close();
  vi.useRealTimers();
});

describe('GET /api/realtime', () => {
  it('opens with a snapshot of active visitors and the recent feed', async () => {
    await track('idsite=1&url=https://one.test/a');
    await track('idsite=2&url=https://two.test/b', '203.0.113.9');

    const frames = await connect();
    const snapshot = (await frames.next()).data as RealtimeSnapshot;
    expect(snapshot.active).toEqual({ 1: 1, 2: 1 });
    expect(snapshot.recent).toEqual([
      { siteId: 1, ts: T0, type: 'pageview', path: '/a', country: 'US', city: 'Boston', ...POINT },
      { siteId: 2, ts: T0, type: 'pageview', path: '/b', country: 'US', city: 'Boston', ...POINT },
    ]);
  });

  it('streams a hit and a version tick to every connected client', async () => {
    const [a, b] = [await connect(), await connect()];
    await Promise.all([a.next(), b.next()]);

    await track('idsite=1&url=https://one.test/live');
    // No timer advance: the feed is fed post-enrichment, not post-flush.
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(0);
    for (const client of [a, b]) {
      const hit = await client.next();
      expect(hit.event).toBe('hit');
      expect(hit.id).toBe('1');
      expect(hit.data).toMatchObject({ siteId: 1, path: '/live', type: 'pageview' });
    }

    vi.advanceTimersByTime(BATCH_INTERVAL_MS);
    for (const client of [a, b]) {
      const version = await client.next();
      expect(version.event).toBe('version');
      expect(version.data).toEqual({ siteId: 1, version: 1 });
      expect(version.id).toBeUndefined(); // only hits move the resume cursor
    }
  });

  it('never streams a ping', async () => {
    const frames = await connect();
    await frames.next();

    await track('idsite=1&url=https://one.test/a&ping=1');
    await track('idsite=1&url=https://one.test/a');

    const hit = await frames.next();
    expect(hit.event).toBe('hit');
    expect(hit.data).toMatchObject({ type: 'pageview' });
  });

  it('never serializes an IP or a visitor id', async () => {
    await track(`idsite=1&url=https://one.test/a&_id=${MATOMO_ID}`);
    const frames = await connect();
    const snapshot = await frames.next();
    await track(`idsite=1&url=https://one.test/b&_id=${MATOMO_ID}`);
    const hit = await frames.next();

    pipeline.flush();
    const visitorHex = db
      .prepare('SELECT lower(hex(visitor_id)) FROM events')
      .pluck()
      .get() as string;
    expect(visitorHex).toHaveLength(16);

    const wire = `${snapshot.raw}\n${hit.raw}`.toLowerCase();
    expect(wire).toContain('/a'); // the assertion below is not vacuous
    expect(wire).toContain('/b');
    expect(wire).not.toContain(CLIENT_IP);
    expect(wire).not.toContain(MATOMO_ID);
    expect(wire).not.toContain(visitorHex);
  });

  it('recounts active visitors on a 10 s tick as the window slides', async () => {
    await track('idsite=1&url=https://one.test/a');
    const frames = await connect();
    expect(((await frames.next()).data as RealtimeSnapshot).active).toEqual({ 1: 1, 2: 0 });

    vi.advanceTimersByTime(ACTIVE_TICK_MS);
    const first = await frames.until('active');
    expect(first.data).toEqual({ active: { 1: 1, 2: 0 } });

    vi.advanceTimersByTime(ACTIVE_WINDOW_MS);
    const later = await frames.until('active', (data) => (data as ActiveFrame).active[1] === 0);
    expect(later.data).toEqual({ active: { 1: 0, 2: 0 } });
  });

  it('keeps the connection warm with a comment every 25 s', async () => {
    const frames = await connect();
    await frames.next();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    const seen = [await frames.next(), await frames.next(), await frames.next()];
    expect(seen.map((frame) => frame.event ?? frame.raw)).toEqual([
      'active',
      'active',
      ': keep-alive',
    ]);
  });

  it('resumes from Last-Event-ID without replaying what the client already had', async () => {
    for (const path of ['/1', '/2', '/3']) await track(`idsite=1&url=https://one.test${path}`);

    const frames = await connect({ 'last-event-id': '1' });
    const snapshot = (await frames.next()).data as RealtimeSnapshot;
    expect(snapshot.recent).toEqual([]); // replayed as `hit` frames instead
    expect(snapshot.active).toEqual({ 1: 1, 2: 0 });

    const replayed = [await frames.next(), await frames.next()];
    expect(replayed.map((frame) => frame.id)).toEqual(['2', '3']);
    expect(replayed.map((frame) => (frame.data as RealtimeHit).path)).toEqual(['/2', '/3']);
  });

  it('honours ?sites= and streams nothing about the others', async () => {
    await track('idsite=2&url=https://two.test/b');
    const frames = await connect({}, '?sites=1');
    const snapshot = (await frames.next()).data as RealtimeSnapshot;
    expect(snapshot.active).toEqual({ 1: 0 });
    expect(snapshot.recent).toEqual([]);

    await track('idsite=2&url=https://two.test/c');
    await track('idsite=1&url=https://one.test/a');
    const hit = await frames.next();
    expect(hit.data).toMatchObject({ siteId: 1, path: '/a' });
  });

  it('rejects a malformed ?sites= with 400 instead of widening to every site', async () => {
    for (const garbage of ['abc', '0', '-1', '1,x', '']) {
      const res = await app.request(`/api/realtime?sites=${garbage}`);
      expect(res.status, `sites=${garbage}`).toBe(400);
    }
  });

  it('fills a filtered snapshot from the whole ring, not just the newest 50 hits', async () => {
    hub.record(event({ ts: T0, path: '/quiet' }));
    for (let i = 0; i < 60; i += 1) {
      hub.record(event({ site_id: 2, ts: T0 + 1 + i, path: `/busy/${i}` }));
    }

    const frames = await connect({}, '?sites=1');
    const snapshot = (await frames.next()).data as RealtimeSnapshot;
    expect(snapshot.recent.map((hit) => hit.path)).toEqual(['/quiet']);
  });

  it('aborts a reader that stops draining instead of queueing frames forever', async () => {
    const baseline = vi.getTimerCount();
    const frames = await connect();
    await frames.next(); // snapshot; after this the client never reads again
    expect(vi.getTimerCount()).toBe(baseline + 2);

    for (let i = 0; i < MAX_QUEUED_FRAMES + 8; i += 1) {
      hub.record(event({ ts: T0 + i, path: `/${i}` }));
    }
    await settle();
    // The connection was torn down exactly as if the client had disconnected.
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('clears its timers when the client disconnects', async () => {
    const baseline = vi.getTimerCount();
    const frames = await connect();
    await frames.next();
    expect(vi.getTimerCount()).toBe(baseline + 2); // recount + heartbeat

    await frames.close();
    await settle();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Geo of every hit in this suite, spread into the expected wire shapes. */
const POINT = { lat: 42.36, lon: -71.06, deviceType: 'desktop' };

interface ActiveFrame {
  active: Record<number, number>;
}

interface Frame {
  /** Exactly the bytes on the wire, for assertions about what must never be there. */
  raw: string;
  event?: string;
  id?: string;
  data: unknown;
}

async function track(query: string, ip = CLIENT_IP): Promise<void> {
  const res = await app.request(`/matomo.php?${query}&rec=1&send_image=0`, {
    headers: { 'x-forwarded-for': ip, 'user-agent': DESKTOP_UA },
  });
  expect(res.status).toBe(204);
}

async function connect(headers: Record<string, string> = {}, query = ''): Promise<Frames> {
  const res = await app.request(`/api/realtime${query}`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const body = res.body;
  if (body === null) throw new Error('realtime response has no body');
  const frames = new Frames(body.getReader());
  open.push(frames);
  return frames;
}

const decoder = new TextDecoder();

/** Reads an SSE stream frame by frame; each `next()` resolves when one arrives. */
class Frames {
  private buffer = '';

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<Frame> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return parseFrame(raw);
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('stream closed');
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  /** Skips frames until one matches — the recount ticks past unrelated traffic. */
  async until(event: string, matches: (data: unknown) => boolean = () => true): Promise<Frame> {
    for (let i = 0; i < 200; i += 1) {
      const frame = await this.next();
      if (frame.event === event && matches(frame.data)) return frame;
    }
    throw new Error(`no matching '${event}' frame`);
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

function parseFrame(raw: string): Frame {
  const frame: Frame = { raw, data: undefined };
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length > 0) frame.data = JSON.parse(data.join('\n'));
  return frame;
}

/** Lets the stream's queued writes and abort listeners run; timers stay frozen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
