import {
  ACTIVE_TICK_MS,
  type RealtimeActive,
  type RealtimeHit,
  type RealtimeSnapshot,
  type VersionTick,
} from '@featherstat/shared';
import type { SiteScope } from './state.ts';

/**
 * The one long-lived connection every view shares (docs/04 § 4, docs/05 "live by
 * default"): a snapshot on connect, then hits, active recounts, and per-site
 * data-version ticks.
 *
 * Reconnection is ours rather than the browser's fixed retry: a server restart
 * would otherwise have every open dashboard hammering the same three-second
 * cadence forever. A fresh connection replies with a full snapshot (active counts
 * plus the last 50 hits), so dropping `Last-Event-ID` — unreachable without
 * request headers — costs a resuming client nothing a dashboard displays.
 */

const DEFAULT_URL = '/api/realtime';
const DEFAULT_MIN_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 30_000;
/**
 * A connection only counts as healthy — resetting the backoff — after surviving
 * this long. Resetting on `open` alone would let an accept-then-die crash loop
 * retry at the minimum delay forever.
 */
const DEFAULT_STEADY_MS = 5_000;
/**
 * The server recounts `active` every ACTIVE_TICK_MS, so a healthy stream is never
 * silent longer than that (its `: keep-alive` comments are invisible to
 * EventSource). Past this deadline the socket is presumed dead — a proxy can hold
 * it open long after the upstream died, without ever firing `error`.
 */
const DEFAULT_STALE_MS = ACTIVE_TICK_MS * 2.5;

/** docs/05: a busy site must not re-issue its batch per hit. */
export const REVALIDATE_DEBOUNCE_MS = 3_000;

interface LiveEvents {
  snapshot: RealtimeSnapshot;
  hit: RealtimeHit;
  active: RealtimeActive;
  version: VersionTick;
  /**
   * Client-synthesized: the snapshot of a RE-connection. Version ticks during the
   * gap are gone, so listeners treat it as "any site may have moved" (docs/05
   * R22 — no stale dashboard left open overnight).
   */
  reconnect: RealtimeSnapshot;
  /** Client-synthesized connection health, emitted on transitions only. */
  status: { connected: boolean };
}
type LiveEventName = keyof LiveEvents;

/** The slice of `EventSource` this module uses — tests supply their own. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface LiveStreamOptions {
  url?: string;
  /** Scopes the stream server-side; `all` (the default) subscribes to every site. */
  sites?: SiteScope;
  open?: (url: string) => EventSourceLike;
  minRetryMs?: number;
  maxRetryMs?: number;
  /** Uptime after which the reconnect backoff resets. */
  steadyMs?: number;
  /** Silence (no frame of any kind) after which the connection is declared dead. */
  staleMs?: number;
}

export interface LiveStream {
  on<K extends LiveEventName>(type: K, handler: (payload: LiveEvents[K]) => void): () => void;
  close(): void;
}

export function createLiveStream(options: LiveStreamOptions = {}): LiveStream {
  const url = `${options.url ?? DEFAULT_URL}?sites=${options.sites ?? 'all'}`;
  const open = options.open ?? ((target: string) => new EventSource(target));
  const minRetryMs = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const steadyMs = options.steadyMs ?? DEFAULT_STEADY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  const handlers = new Map<LiveEventName, Set<(payload: never) => void>>();
  let source: EventSourceLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let steadyTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let closed = false;
  let connectedOnce = false;
  let down = false;

  const notify = <K extends LiveEventName>(type: K, payload: LiveEvents[K]): void => {
    const listeners = handlers.get(type);
    if (listeners === undefined || listeners.size === 0) return;
    for (const listener of [...listeners]) (listener as (value: LiveEvents[K]) => void)(payload);
  };

  const parse = <K extends LiveEventName>(
    event: MessageEvent<string>,
  ): LiveEvents[K] | undefined => {
    try {
      return JSON.parse(event.data) as LiveEvents[K];
    } catch {
      return undefined; // a truncated frame is a dropped frame, never a dead stream
    }
  };

  const clearConnectionTimers = (): void => {
    if (steadyTimer !== undefined) clearTimeout(steadyTimer);
    if (watchdog !== undefined) clearTimeout(watchdog);
    steadyTimer = undefined;
    watchdog = undefined;
  };

  const connect = (): void => {
    const current = open(url);
    source = current;

    const fail = (): void => {
      if (closed || source !== current) return;
      current.close(); // we own the retry schedule, not the browser's fixed one
      source = undefined;
      clearConnectionTimers();
      if (!down) {
        down = true;
        notify('status', { connected: false });
      }
      const delay = Math.min(maxRetryMs, minRetryMs * 2 ** failures);
      failures += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const alive = (): void => {
      if (closed || source !== current) return;
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = setTimeout(fail, staleMs);
    };

    const emit = <K extends LiveEventName>(type: K, event: MessageEvent<string>): void => {
      alive();
      const payload = parse<K>(event);
      if (payload !== undefined) notify(type, payload);
    };

    current.addEventListener('open', () => {
      if (closed || source !== current) return;
      if (steadyTimer !== undefined) clearTimeout(steadyTimer);
      steadyTimer = setTimeout(() => {
        failures = 0;
      }, steadyMs);
    });
    current.addEventListener('snapshot', (event) => {
      alive();
      const payload = parse<'snapshot'>(event);
      if (payload === undefined) return;
      notify('snapshot', payload);
      if (down) {
        down = false;
        notify('status', { connected: true });
      }
      if (connectedOnce) notify('reconnect', payload);
      connectedOnce = true;
    });
    current.addEventListener('hit', (event) => emit('hit', event));
    current.addEventListener('active', (event) => emit('active', event));
    current.addEventListener('version', (event) => emit('version', event));
    current.addEventListener('error', fail);

    alive(); // the handshake itself is on the clock — a hung proxy never errors
  };
  connect();

  return {
    on(type, handler) {
      let listeners = handlers.get(type);
      if (listeners === undefined) {
        listeners = new Set();
        handlers.set(type, listeners);
      }
      const entry = handler as (payload: never) => void;
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    close() {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      clearConnectionTimers();
      source?.close();
      source = undefined;
      handlers.clear();
    },
  };
}

export interface RevalidateOptions {
  /** Read at tick time, so switching sites needs no resubscription. */
  site: () => SiteScope;
  /**
   * Identity of the view state whose batch a tick would re-run — captured when
   * the debounce window opens, checked again when it fires. A timer armed for one
   * state must never re-issue (and abort) the batch of the next: the state change
   * already ran its own batch.
   */
  key?: () => unknown;
  delayMs?: number;
}

/**
 * Turns version ticks for the viewed site into one re-query of the view's batch.
 *
 * The window opens on the first tick and fires at its end, coalescing everything
 * that arrived meanwhile — a resetting debounce would starve a site that never
 * goes quiet for three seconds, which is precisely the site worth watching live.
 *
 * A reconnection counts as a tick for every site: version frames during the gap
 * are gone, and an unchanged view revalidates to a cheap 304.
 */
export function createRevalidator(
  live: LiveStream,
  revalidate: () => void,
  options: RevalidateOptions,
): () => void {
  const delayMs = options.delayMs ?? REVALIDATE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (timer !== undefined) return;
    const armed = options.key?.();
    timer = setTimeout(() => {
      timer = undefined;
      if (options.key !== undefined && options.key() !== armed) return;
      revalidate();
    }, delayMs);
  };

  const offVersion = live.on('version', (tick) => {
    const site = options.site();
    if (site !== 'all' && site !== tick.siteId) return;
    arm();
  });
  const offReconnect = live.on('reconnect', () => arm());

  return () => {
    offVersion();
    offReconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
