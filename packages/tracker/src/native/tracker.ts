import type { HitType } from '@featherstat/shared';
import { isExitPingWorthwhile } from '../exit.ts';
import { classifyLink, isLinkActivation } from '../links.ts';
import { type HistoryChange, isNewView } from '../navigation.ts';
import { whenActivated } from '../prerender.ts';
import { isRepeatView } from '../repeat.ts';
import { documentHeight, READ_THRESHOLD_PCT, scrollDepthPct } from '../scroll.ts';
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

/** Custom props, sent untouched — the server owns every cap (docs/03 § Props). */
export type TrackProps = Record<string, string | number | boolean>;

export interface EventProps {
  category?: string;
  name?: string;
  value?: number;
  props?: TrackProps;
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
  /** How far down this page the reader has got, 0–100 (scroll.ts). Pings only. */
  scroll?: number;
  props?: TrackProps;
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
  /** Deepest point reached on the CURRENT page; reset by `page()`. */
  maxScroll: number;
  /** Whether this page view has already reported passing the read threshold. */
  read: boolean;
  /** Heartbeats this page view has held the reader through; reset by `page()`. */
  beats: number;
  /**
   * The `missing` prop this page view was reported with — `MISSING_PROP` in
   * `packages/shared` (docs/10 § 3). Set, the page does not exist and nothing
   * on it is traffic, so nothing after its page view is sent (`emit`).
   */
  missing?: TrackProps[string];
  /** Restart the heartbeat, so a page view's first beat is a whole interval after it. */
  rearm: () => void;
  stop: () => void;
}

const DEFAULT_ENDPOINT = '/api/collect';
const DEFAULT_HEARTBEAT_SECONDS = 15;
/** Focus alone overstates engagement: a focused tab on a second monitor pings forever (docs/04 § 2). */
const DEFAULT_IDLE_SECONDS = 60;
/** `track('signup')` with no category still needs one server-side. */
const DEFAULT_EVENT_CATEGORY = 'custom';
/** The reserved category/action the read milestone lands under — `READ_MILESTONE` in
 * `packages/shared`, which the server keeps out of bounce (docs/04 § 2). */
const SCROLL_CATEGORY = 'scroll';
const READ_ACTION = 'read';
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
const INPUT_OPTIONS = { capture: true, passive: true } as const;

let runtime: Runtime | undefined;

/**
 * The page as REPORTED, which is not always the page in the address bar.
 *
 * A view announced under its own URL — `page('…/404', …)` for a page that does
 * not exist, or an SPA naming its route — owns every hit that follows it, and
 * they must all say so. Reading `location.href` instead scatters one page view
 * across two paths: the pageview lands on the reported URL while its pings,
 * read milestone and link clicks land on the raw one, which then shows up in
 * path reports as a second, view-less row for a page nobody visited.
 *
 * Falls back to the real location before the first view is announced, so a hit
 * that somehow precedes it is still addressed to something real.
 */
const viewUrl = (): string => runtime?.url || location.href;

/** Start tracking. Calling it again replaces the running tracker; the result detaches it. */
export function init(config: TrackerConfig): () => void {
  runtime?.stop();

  const heartbeatMs = (config.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;
  const idleMs = (config.idleSeconds ?? DEFAULT_IDLE_SECONDS) * 1000;
  const autoPageviews = config.autoPageviews !== false;

  let focused = !document.hasFocus || document.hasFocus();
  let visible = document.visibilityState !== 'hidden';
  let lastInput = Date.now();
  /** Whether this departure has already been reported; cleared when the page returns. */
  let exited = false;

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
    if (visible) exited = false;
    else exitPing();
  };
  /**
   * The visit's last hit, so the tail before leaving is credited (exit.ts).
   * Latched until the page comes back: the time between hiding and a later
   * `pagehide` is the visitor being elsewhere, not reading.
   */
  const exitPing = (): void => {
    if (exited || !runtime) return;
    if (!isExitPingWorthwhile(runtime.lastHitAt, Date.now(), heartbeatMs)) return;
    exited = true;
    measure();
    emit({ type: 'ping', url: viewUrl(), scroll: reading() });
  };
  /**
   * Re-read the depth. Cheap enough to run on input, but `documentHeight` forces
   * layout, so it is throttled to a frame — the reading only has to be right by
   * the next heartbeat, not on every pixel of a scroll.
   */
  let framePending = false;
  const measure = (): void => {
    if (!runtime) return;
    const pct = scrollDepthPct(window.scrollY, window.innerHeight, documentHeight(document));
    if (pct > runtime.maxScroll) runtime.maxScroll = pct;
    // One event per page view, the first time the threshold is passed by a page
    // view that has held the reader through a heartbeat. Depth alone is not
    // reading: a page that fits the viewport is 100 % the moment it loads. An
    // ordinary custom event on purpose: it needs no new hit type, and so counts,
    // filters and shows up in the live feed exactly like any other (docs/04 § 2).
    if (!runtime.read && runtime.beats > 0 && runtime.maxScroll >= READ_THRESHOLD_PCT) {
      runtime.read = true;
      emit({ type: 'event', url: viewUrl(), category: SCROLL_CATEGORY, action: READ_ACTION });
    }
  };
  /**
   * The depth to report, or nothing. `scrollDepthPct` returns 0 only for a page
   * it could not measure — no layout yet, a zero-height document — and any real
   * page gives at least the viewport's share, so 0 means "unknown" rather than
   * "saw nothing". Sending it would be the measurement gap passed off as a
   * reader who bounced off the header.
   */
  const reading = (): number | undefined =>
    runtime !== undefined && runtime.maxScroll > 0 ? runtime.maxScroll : undefined;
  const throttledMeasure = (): void => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      measure();
    });
  };
  const onInput = (): void => {
    lastInput = Date.now();
    // `scroll` is already one of INPUT_EVENTS, so this needs no listener of its own.
    throttledMeasure();
  };
  /** The address bar as the history hook last saw it (navigation.ts). */
  let seen = '';
  const onNavigate = (change: HistoryChange): void => {
    const from = seen;
    seen = location.href;
    if (isNewView(from, seen, change)) page();
  };
  const onClick = (event: Event): void => {
    if (!isLinkActivation(event)) return;
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor?.href) return;
    const target = classifyLink(anchor.href, location.hostname, anchor.hasAttribute('download'));
    if (target) {
      emit({
        type: target.kind === 'download' ? 'download' : 'outlink',
        url: viewUrl(),
        targetUrl: target.url,
      });
    }
  };

  const beat = (): void => {
    if (runtime && focused && visible && Date.now() - lastInput < idleMs) {
      runtime.beats += 1;
      // Measure first: a page that grew after load — lazy images, deferred
      // content — moves the end away without the reader touching anything, and
      // only a fresh reading notices.
      measure();
      emit({ type: 'ping', url: viewUrl(), scroll: reading() });
    }
  };
  let heartbeat = setInterval(beat, heartbeatMs);

  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', exitPing);
  for (const event of INPUT_EVENTS) document.addEventListener(event, onInput, INPUT_OPTIONS);
  if (config.autoLinks !== false) {
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
  }
  /** Drops a first page view still waiting on activation (prerender.ts). */
  let unwait: (() => void) | undefined;
  let unhook: (() => void) | undefined;

  const started: Runtime = {
    site: config.site,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    url: '',
    viewAt: 0,
    lastHitAt: 0,
    maxScroll: 0,
    read: false,
    beats: 0,
    rearm: () => {
      clearInterval(heartbeat);
      heartbeat = setInterval(beat, heartbeatMs);
    },
    stop: () => {
      clearInterval(heartbeat);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', exitPing);
      for (const event of INPUT_EVENTS) document.removeEventListener(event, onInput, INPUT_OPTIONS);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
      unhook?.();
      unwait?.();
    },
  };
  runtime = started;

  // Not `page()` directly: a prerendered document reaches here before the visitor
  // has decided to come, and the view it would announce is not one yet
  // (prerender.ts). The history hook waits too — a router hydrating the
  // speculated page rewrites the URL before anyone has arrived. The identity
  // check keeps a prerender that activates late from announcing its view onto
  // whichever tracker has since replaced this one.
  if (autoPageviews) {
    unwait = whenActivated(() => {
      if (runtime !== started) return;
      seen = location.href;
      unhook = hookHistory(onNavigate);
      page();
    });
  }

  // Scoped teardown: a stale handle never stops a tracker that replaced it.
  return () => {
    if (runtime !== started) return;
    started.stop();
    runtime = undefined;
  };
}

/** Record a pageview; defaults to the current document. Repeats are dropped (repeat.ts). */
export function page(
  url: string = location.href,
  title: string = document.title,
  props?: TrackProps,
): void {
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
  // A new page is a new measurement, so an SPA route change does not inherit
  // the depth of the page before it. Nothing is read here: until the router has
  // swapped the document and moved the scroll position, both still belong to
  // the page before, and the first heartbeat measures before it pings anyway.
  runtime.maxScroll = 0;
  runtime.read = false;
  runtime.beats = 0;
  runtime.missing = undefined;
  // An SPA route announced just before a tick would otherwise earn its "beat"
  // a second after it began.
  runtime.rearm();
  emit({
    type: 'pageview',
    url,
    title: title || undefined,
    referrer: referrer || undefined,
    screen: `${screen.width}x${screen.height}`,
    lang: navigator.language,
    props,
  });
  // Only now: the not-found page view itself is the one hit it still sends.
  runtime.missing = props?.missing;
}

/** Record a custom event: `track('copy-link', { category: 'share' })`. */
export function track(action: string, props: EventProps = {}): void {
  emit({
    type: 'event',
    url: viewUrl(),
    category: props.category ?? DEFAULT_EVENT_CATEGORY,
    action,
    name: props.name,
    value: props.value,
    props: props.props,
  });
}

/**
 * One request per hit: the collector accepts batches (docs/04 § 2), but a
 * queue would trade lost hits on unload for savings this payload doesn't need.
 */
function emit(hit: NativeHit): void {
  if (!runtime || runtime.missing) return;
  runtime.lastHitAt = Date.now();
  send(runtime.endpoint, JSON.stringify({ site: runtime.site, hits: [hit] }));
}

function hookHistory(onNavigate: (change: HistoryChange) => void): () => void {
  const { pushState, replaceState } = history;
  const onPop = (): void => onNavigate('pop');
  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    pushState.apply(this, args);
    onNavigate('push');
  };
  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History['replaceState']>
  ) {
    replaceState.apply(this, args);
    onNavigate('replace');
  };
  window.addEventListener('popstate', onPop);
  return () => {
    window.removeEventListener('popstate', onPop);
    history.pushState = pushState;
    history.replaceState = replaceState;
  };
}
