import type { Hit, HitContext, NtfyRule } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_UA, event, openTestDb, T0 } from '../../test/rows.ts';
import { createAuth } from '../auth/auth.ts';
import { type Db, deleteSetting, withWriteTransaction } from '../db/index.ts';
import type { GeoProvider } from '../pipeline/geo.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { createNtfyIntegration } from './index.ts';
import { createNtfyNotifier, type NtfyFetch, type NtfyRequestInit } from './ntfy.ts';
import { NTFY_SETTING_KEYS, writeNtfySettings } from './settings.ts';

const NTFY_URL = 'https://ntfy.test';
const TOPIC = 'analytics';
const ENDPOINT = `${NTFY_URL}/${TOPIC}`;

interface Sent {
  url: string;
  init: NtfyRequestInit;
}

/** A fetch stub that answers immediately; `deferred` never resolves. */
function stubFetch(mode: 'ok' | 'deferred' | 'reject' | 'refused' = 'ok'): {
  calls: Sent[];
  fetchFn: NtfyFetch;
} {
  const calls: Sent[] = [];
  return {
    calls,
    fetchFn: (url, init) => {
      calls.push({ url, init });
      if (mode === 'deferred') return new Promise(() => undefined);
      if (mode === 'reject') return Promise.reject(new Error('connection refused'));
      return Promise.resolve({ ok: mode === 'ok' });
    },
  };
}

/** Lets every queued microtask (the deferred POSTs) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let db: Db;
let clock: number;

beforeEach(() => {
  db = openTestDb(2);
  clock = T0;
});

afterEach(() => {
  db.close();
});

function configure(rules: NtfyRule[], extra: { token?: string; url?: string } = {}): void {
  withWriteTransaction(db, () => {
    writeNtfySettings(db, { url: extra.url ?? NTFY_URL, topic: TOPIC, rules, ...extra });
  });
}

const signup = {
  event_category: 'signup',
  event_action: 'account-created',
  type: 'event',
} as const;

describe('rule matching', () => {
  it('fires on a single-field rule and ignores everything else', async () => {
    configure([{ eventCategory: 'signup' }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    notifier.record(event({ ...signup }));
    notifier.record(event({ type: 'event', event_category: 'video', event_action: 'play' }));
    notifier.record(event());
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(notifier.stats()).toMatchObject({ sent: 1, failed: 0, dropped: 0, suppressed: 0 });
  });

  it('requires every present field of a multi-field rule', async () => {
    configure([{ site: 2, eventCategory: 'signup', eventAction: 'account-created', label: 'pro' }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    const full = { ...signup, site_id: 2, event_name: 'pro' };
    notifier.record(event({ ...full, site_id: 1 })); // wrong site
    notifier.record(event({ ...full, event_action: 'account-deleted' })); // wrong action
    notifier.record(event({ ...full, event_name: 'free' })); // wrong label
    notifier.record(event({ ...full, event_name: undefined })); // no label at all
    await settle();
    expect(calls).toHaveLength(0);

    notifier.record(event(full));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.headers.Title).toBe('two signup: account-created');
  });

  it('stays idle when no rule, url or topic is configured', async () => {
    const { calls, fetchFn } = stubFetch();
    const idle = createNtfyNotifier(db, { fetchFn, now: () => clock });
    idle.record(event({ ...signup }));

    configure([{ eventCategory: 'signup' }]);
    withWriteTransaction(db, () => deleteSetting(db, NTFY_SETTING_KEYS.url));
    const unconfigured = createNtfyNotifier(db, { fetchFn, now: () => clock });
    unconfigured.record(event({ ...signup }));
    await settle();

    expect(calls).toHaveLength(0);
  });

  it('never fires on pings', async () => {
    configure([{ site: 1 }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    notifier.record(event({ type: 'ping' }));
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('picks up rules saved after it started', async () => {
    configure([]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    notifier.record(event({ ...signup }));
    await settle();
    expect(calls).toHaveLength(0);

    configure([{ eventCategory: 'signup' }]);
    notifier.reload();
    notifier.record(event({ ...signup }));
    await settle();
    expect(calls).toHaveLength(1);
  });
});

describe('cooldown', () => {
  it('spaces a rule out and keeps other rules independent', async () => {
    configure([{ eventCategory: 'signup' }, { eventCategory: 'video' }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock, cooldownMs: 60_000 });
    const video = { type: 'event', event_category: 'video', event_action: 'play' } as const;

    notifier.record(event({ ...signup }));
    notifier.record(event({ ...signup }));
    clock += 59_000;
    notifier.record(event({ ...signup }));
    notifier.record(event({ ...video })); // a different rule is not held back
    await settle();
    expect(calls).toHaveLength(2);
    expect(notifier.stats()).toMatchObject({ sent: 2, suppressed: 2 });

    clock += 1_000;
    notifier.record(event({ ...signup }));
    await settle();
    expect(calls).toHaveLength(3);
  });

  it('survives an unrelated settings save', async () => {
    configure([{ eventCategory: 'signup' }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock, cooldownMs: 60_000 });

    notifier.record(event({ ...signup }));
    configure([{ eventCategory: 'signup' }, { eventCategory: 'video' }]);
    notifier.reload();
    notifier.record(event({ ...signup }));
    await settle();

    expect(calls).toHaveLength(1);
    expect(notifier.stats()).toMatchObject({ suppressed: 1 });
  });
});

describe('delivery', () => {
  it('bounds the backlog, dropping oldest, and never blocks the caller', async () => {
    configure([{ eventCategory: 'signup' }]);
    const { calls, fetchFn } = stubFetch('deferred');
    const notifier = createNtfyNotifier(db, {
      fetchFn,
      now: () => clock,
      cooldownMs: 0,
      maxPending: 2,
      maxInFlight: 1,
    });

    for (let i = 0; i < 5; i += 1) notifier.record(event({ ...signup, event_name: `n${i}` }));
    await settle();

    expect(calls).toHaveLength(1); // one in flight, the rest queued or dropped
    expect(notifier.stats()).toMatchObject({ sent: 0, dropped: 2, pending: 3 });
  });

  it('keeps the title header injection-proof and ASCII on the wire', async () => {
    configure([{ eventCategory: 'signup' }]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock, cooldownMs: 0 });

    notifier.record(event({ ...signup, event_action: 'a\r\nX-Injected: 1' }));
    notifier.record(event({ ...signup, event_action: 'café' }));
    await settle();

    expect(calls[0]?.init.headers.Title).toBe('one signup: a  X-Injected: 1');
    const encoded = Buffer.from('one signup: café', 'utf8').toString('base64');
    expect(calls[1]?.init.headers.Title).toBe(`=?UTF-8?B?${encoded}?=`);
  });

  it('counts a refusal and a transport error as failures, not deliveries', async () => {
    configure([{ eventCategory: 'signup' }]);
    const refused = stubFetch('refused');
    const refusing = createNtfyNotifier(db, {
      fetchFn: refused.fetchFn,
      now: () => clock,
      cooldownMs: 0,
    });
    const rejected = stubFetch('reject');
    const rejecting = createNtfyNotifier(db, {
      fetchFn: rejected.fetchFn,
      now: () => clock,
      cooldownMs: 0,
    });

    refusing.record(event({ ...signup }));
    rejecting.record(event({ ...signup }));
    await settle();

    expect(refusing.stats()).toMatchObject({ sent: 0, failed: 1 });
    expect(rejecting.stats()).toMatchObject({ sent: 0, failed: 1 });
  });

  it('sends Authorization only when a token is configured, and joins url and topic once', async () => {
    configure([{ eventCategory: 'signup' }], { url: `${NTFY_URL}/` });
    const anonymous = stubFetch();
    createAndRecord(anonymous.fetchFn);
    configure([{ eventCategory: 'signup' }], { token: 'tk_secret' });
    const authorized = stubFetch();
    createAndRecord(authorized.fetchFn);
    await settle();

    expect(anonymous.calls[0]?.url).toBe(ENDPOINT);
    expect(anonymous.calls[0]?.init.headers.Authorization).toBeUndefined();
    expect(authorized.calls[0]?.init.headers.Authorization).toBe('Bearer tk_secret');
  });

  function createAndRecord(fetchFn: NtfyFetch): void {
    createNtfyNotifier(db, { fetchFn, now: () => clock }).record(event({ ...signup }));
  }
});

describe('test delivery', () => {
  it('sends one notification immediately with the stored endpoint and token', async () => {
    configure([], { token: 'tk_secret' });
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    // No rules configured: the button must still prove the endpoint.
    expect(await notifier.test()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer tk_secret');
    expect(notifier.stats()).toMatchObject({ sent: 1, failed: 0, pending: 0 });
  });

  it('attempts nothing while the endpoint is unconfigured', async () => {
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    expect(await notifier.test()).toMatchObject({ ok: false, unconfigured: true });
    expect(calls).toHaveLength(0);
  });

  it('reports a refusal and a transport error as the failures they are', async () => {
    configure([]);
    const refused = createNtfyNotifier(db, { fetchFn: stubFetch('refused').fetchFn });
    const unreachable = createNtfyNotifier(db, { fetchFn: stubFetch('reject').fetchFn });

    expect(await refused.test()).toMatchObject({ ok: false });
    expect(await unreachable.test()).toEqual({ ok: false, error: 'connection refused' });
    expect(refused.stats().failed).toBe(1);
    expect(unreachable.stats().failed).toBe(1);
  });

  it('bypasses the cooldown — the button answers every time it is pressed', async () => {
    configure([]);
    const { calls, fetchFn } = stubFetch();
    const notifier = createNtfyNotifier(db, { fetchFn, now: () => clock });

    await notifier.test();
    await notifier.test();

    expect(calls).toHaveLength(2);
  });
});

describe('privacy of the payload', () => {
  const BOSTON: GeoProvider = {
    lookup: () => ({ country: 'US', region: 'Massachusetts', city: 'Boston', lat: 42.4, lon: -71 }),
  };
  const IP = '203.0.113.5';
  const UID = 'user-42';

  let pipeline: Pipeline;

  afterEach(() => {
    pipeline.shutdown();
  });

  it('carries the site, the event and its place — never the visitor', async () => {
    configure([{ eventCategory: 'signup' }]);
    const { calls, fetchFn } = stubFetch();
    pipeline = createPipeline(db, { geo: BOSTON });
    // The integration factory is the production path: pipeline hook + routes.
    const auth = createAuth(db, { disabled: true, env: { NODE_ENV: 'test' }, log: () => {} });
    createNtfyIntegration(db, pipeline, auth, { fetchFn, now: () => clock });

    const hit: Hit = {
      siteId: 1,
      type: 'event',
      url: 'https://one.test/pricing',
      uid: UID,
      event: { category: 'signup', action: 'account-created' },
    };
    const ctx: HitContext = { ip: IP, userAgent: DESKTOP_UA, receivedAt: T0 };
    pipeline.sink([hit], ctx);
    await settle();

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    // Exact equality is the assertion: anything leaking would have to show up here.
    expect(sent?.init.headers.Title).toBe('one signup: account-created');
    expect(sent?.init.body).toBe('/pricing\nBoston, US\n2026-07-27 10:00');

    const wire = JSON.stringify({
      url: sent?.url,
      headers: sent?.init.headers,
      body: sent?.init.body,
    });
    expect(wire).not.toContain(IP);
    expect(wire).not.toContain(UID);
    expect(wire.toLowerCase()).not.toContain('visitor');
  });
});
