import type { HitType } from '@featherstat/shared';
import { isExitPingWorthwhile } from '../exit.ts';
import { classifyLink } from '../links.ts';
import { isRepeatView } from '../repeat.ts';
import { send } from '../send.ts';

/** The native tracker for new sites (docs/04 § 2): `POST /api/collect`, JSON, ESM. */
export interface TrackerConfig {
  site: number;
  /** Collector URL; defaults to `/api/collect` on the current origin. */
  endpoint?: string;
  /** Auto pageviews via a `history` hook — opt out when the app tracks its own routes. */
  autoPageviews?: boolean;
  /** Auto outlink/download tracking by click delegation. */
  autoLinks?: boolean;
  heartbeatSeconds?: number;
  /** Silence after this much time without input pauses the pings. */
  idleSeconds?: number;
}

export interface EventProps {
  category?: string;
  name?: string;
  value?: number;
}

/** One hit of the collect payload; `JSON.stringify` drops the absent fields. */
interface NativeHit {
  type: HitType;
  url?: string;
  title?: string;
  referrer?: string;
  targetUrl?: string;
  category?: string;
  action?: string;
  name?: string;
  value?: number;
  screen?: string;
  lang?: string;
}

interface Runtime {
  site: number;
  endpoint: string;
  /** URL of the last pageview — also the referrer of the next one within the app. */
  url: string;
  /** When that pageview was taken; with `url` it is the repeat-view guard's memory (repeat.ts). */
  viewAt: number;
  /** When a hit last went out — what the exit ping credits from (exit.ts). */
  lastHitAt: number;
  stop: () => void;
}

const DEFAULT_ENDPOINT = '/api/collect';
const DEFAULT_HEARTBEAT_SECONDS = 15;
/** Focus alone overstates engagement: a focused tab on a second monitor pings forever (docs/04 § 2). */
const DEFAULT_IDLE_SECONDS = 60;
/** `track('signup')` with no category still needs one server-side. */
const DEFAULT_EVENT_CATEGORY = 'custom';
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
const INPUT_OPTIONS = { capture: true, passive: true } as const;

let runtime: Runtime | undefined;

/** Start tracking. Calling it again replaces the running tracker; the result detaches it. */
export function init(config: TrackerConfig): () => void {
  runtime?.stop();

  const heartbeatMs = (config.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;
  const idleMs = (config.idleSeconds ?? DEFAULT_IDLE_SECONDS) * 1000;
  const autoPageviews = config.autoPageviews !== false;

  let focused = !document.hasFocus || document.hasFocus();
  let visible = document.visibilityState !== 'hidden';
  let lastInput = Date.now();

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
  /** The visit's last hit, so the tail before leaving is credited (exit.ts). */
  const exitPing = (): void => {
    if (!runtime || !isExitPingWorthwhile(runtime.lastHitAt, Date.now(), heartbeatMs)) return;
    emit({ type: 'ping', url: location.href });
  };
  const onInput = (): void => {
    lastInput = Date.now();
  };
  const onNavigate = (): void => {
    if (location.href !== runtime?.url) page();
  };
  const onClick = (event: Event): void => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor?.href) return;
    const target = classifyLink(anchor.href, location.hostname, anchor.hasAttribute('download'));
    if (target) {
      emit({
        type: target.kind === 'download' ? 'download' : 'outlink',
        url: location.href,
        targetUrl: target.url,
      });
    }
  };

  const heartbeat = setInterval(() => {
    if (focused && visible && Date.now() - lastInput < idleMs) {
      emit({ type: 'ping', url: location.href });
    }
  }, heartbeatMs);

  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', exitPing);
  for (const event of INPUT_EVENTS) document.addEventListener(event, onInput, INPUT_OPTIONS);
  if (config.autoLinks !== false) document.addEventListener('click', onClick, true);
  if (autoPageviews) window.addEventListener('popstate', onNavigate);
  const unhook = autoPageviews ? hookHistory(onNavigate) : undefined;

  const started: Runtime = {
    site: config.site,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    url: '',
    viewAt: 0,
    lastHitAt: 0,
    stop: () => {
      clearInterval(heartbeat);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', exitPing);
      for (const event of INPUT_EVENTS) document.removeEventListener(event, onInput, INPUT_OPTIONS);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onNavigate);
      unhook?.();
    },
  };
  runtime = started;

  if (autoPageviews) page();

  // Scoped teardown: a stale handle never stops a tracker that replaced it.
  return () => {
    if (runtime !== started) return;
    started.stop();
    runtime = undefined;
  };
}

/** Record a pageview; defaults to the current document. Repeats are dropped (repeat.ts). */
export function page(url: string = location.href, title: string = document.title): void {
  if (!runtime) return;
  const at = Date.now();
  // One navigation an SPA router announced twice — through the history hook and
  // again from the app — is one page view.
  if (isRepeatView(url, at, runtime.url, runtime.viewAt)) return;
  // Within the app the previous view is the referrer; only the first pageview
  // of a visit can learn where the visitor came from.
  const referrer = runtime.url || document.referrer;
  runtime.url = url;
  runtime.viewAt = at;
  emit({
    type: 'pageview',
    url,
    title: title || undefined,
    referrer: referrer || undefined,
    screen: `${screen.width}x${screen.height}`,
    lang: navigator.language,
  });
}

/** Record a custom event: `track('copy-link', { category: 'share' })`. */
export function track(action: string, props: EventProps = {}): void {
  emit({
    type: 'event',
    url: location.href,
    category: props.category ?? DEFAULT_EVENT_CATEGORY,
    action,
    name: props.name,
    value: props.value,
  });
}

/**
 * One request per hit: the collector accepts batches (docs/04 § 2), but a
 * queue would trade lost hits on unload for savings this payload doesn't need.
 */
function emit(hit: NativeHit): void {
  if (!runtime) return;
  runtime.lastHitAt = Date.now();
  send(runtime.endpoint, JSON.stringify({ site: runtime.site, hits: [hit] }));
}

function hookHistory(onNavigate: () => void): () => void {
  const { pushState, replaceState } = history;
  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    pushState.apply(this, args);
    onNavigate();
  };
  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History['replaceState']>
  ) {
    replaceState.apply(this, args);
    onNavigate();
  };
  return () => {
    history.pushState = pushState;
    history.replaceState = replaceState;
  };
}
