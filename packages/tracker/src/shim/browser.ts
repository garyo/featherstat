import { isExitPingWorthwhile } from '../exit.ts';
import { classifyLink } from '../links.ts';
import { send } from '../send.ts';
import {
  type Effect,
  INITIAL_STATE,
  type PageInfo,
  ping,
  type Reduction,
  reduce,
  type ShimState,
} from './core.ts';

declare global {
  interface Window {
    /** The Matomo tag queue: filled before this script loads, executed immediately after. */
    _paq?: unknown[];
    /** Double-install guard — a page including matomo.js twice must not double-ping. */
    __analyticsShim?: boolean;
  }
}

/**
 * Install the matomo.js shim on the current page: drain whatever the tag
 * queued, then run every later `_paq.push` as it happens. The returned
 * function detaches everything again (teardown, tests).
 *
 * Deliberately no SPA auto-tracking — the blog re-pushes itself on
 * `astro:page-load` and a history hook here would double-count (docs/04 § 1).
 * An app that pushes `trackPageView` twice for one navigation is caught in
 * `core.ts` instead: this guard is about installing twice, that one about
 * announcing twice.
 */
export function startShim(): () => void {
  // Second <script src="matomo.js"> on one page: the first shim keeps working
  // (its heartbeat and `_paq.push` stay in charge); the newcomer bows out.
  if (window.__analyticsShim === true) return () => {};
  window.__analyticsShim = true;

  let state: ShimState = INITIAL_STATE;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Interval the tag asked for; the exit ping measures its bounds in these. */
  let heartbeatMs = 0;
  /** When a beacon last went out — what the exit ping credits from (exit.ts). */
  let lastHitAt = 0;
  let linkTracking = false;
  let focused = !document.hasFocus || document.hasFocus();
  let visible = document.visibilityState !== 'hidden';

  const apply = (reduction: Reduction): void => {
    state = reduction.state;
    for (const effect of reduction.effects) run(effect);
  };

  const run = (effect: Effect): void => {
    switch (effect.kind) {
      case 'beacon':
        lastHitAt = Date.now();
        send(effect.beacon.url, effect.beacon.body);
        return;
      case 'heartbeat':
        startHeartbeat(effect.seconds);
        return;
      case 'link-tracking':
        startLinkTracking();
        return;
      case 'debug':
        console.debug(effect.message);
        return;
    }
  };

  const dispatch = (command: unknown): void => {
    apply(reduce(state, command, pageInfo()));
  };

  // Focus-gated, exactly like the tags expect. No idle gating: the shim must
  // match Matomo's focus-only semantics during the bake (docs/04 § 2).
  const startHeartbeat = (seconds: number): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeatMs = seconds * 1000;
    heartbeat = setInterval(() => {
      if (focused && visible) apply(ping(state, pageInfo()));
    }, heartbeatMs);
  };

  /**
   * The visit's last hit, so the tail between the final heartbeat and leaving
   * is credited instead of lost (exit.ts). Gated on the heartbeat running: a
   * tag that never asked for engagement timing does not start getting pings.
   */
  const exitPing = (): void => {
    if (heartbeat === undefined) return;
    if (!isExitPingWorthwhile(lastHitAt, Date.now(), heartbeatMs)) return;
    apply(ping(state, pageInfo()));
  };

  const startLinkTracking = (): void => {
    if (linkTracking) return;
    linkTracking = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
  };

  const onClick = (event: Event): void => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor?.href) return;
    const target = classifyLink(anchor.href, location.hostname, anchor.hasAttribute('download'));
    if (target) dispatch(['trackLink', target.url, target.kind]);
  };

  const onFocus = (): void => {
    focused = true;
  };
  const onBlur = (): void => {
    focused = false;
  };
  const onVisibility = (): void => {
    visible = document.visibilityState !== 'hidden';
    // Hiding is where attention actually stops, and on mobile it is the last
    // callback that reliably runs at all — `pagehide` is only the backstop.
    if (!visible) exitPing();
  };

  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', exitPing);

  window._paq = window._paq ?? [];
  const queue = window._paq;
  const queued = queue.splice(0, queue.length);
  queue.push = (...commands: unknown[]): number => {
    for (const command of commands) dispatch(command);
    return 0;
  };
  for (const command of queued) dispatch(command);

  return () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', exitPing);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('auxclick', onClick, true);
    Reflect.deleteProperty(queue, 'push');
    window.__analyticsShim = false;
  };
}

function pageInfo(): PageInfo {
  return {
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    at: Date.now(),
    screen: `${screen.width}x${screen.height}`,
    lang: navigator.language,
  };
}
