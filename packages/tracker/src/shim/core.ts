/**
 * The `_paq` queue as a pure reducer: commands in, next state plus effects out.
 * Everything the browser owns — timers, listeners, delivery — lives in
 * `browser.ts`, so the compatibility surface (docs/04 § 1) is unit-testable
 * without a DOM.
 */

/** Ordered tracking parameters; the shim encodes its own bodies to stay small. */
export type Params = readonly (readonly [string, string])[];

/** What the DOM knows at the moment a command is pushed. */
export interface PageInfo {
  url: string;
  title: string;
  referrer: string;
  /** `screen.width` × `screen.height`. */
  screen?: string;
  lang?: string;
}

export interface Beacon {
  /** `setTrackerUrl` — where the hit goes. */
  url: string;
  /** Form-encoded matomo.php parameters, POSTed as the beacon body. */
  body: string;
}

export type Effect =
  | { readonly kind: 'beacon'; readonly beacon: Beacon }
  | { readonly kind: 'heartbeat'; readonly seconds: number }
  | { readonly kind: 'link-tracking' }
  | { readonly kind: 'debug'; readonly message: string };

export interface ShimState {
  readonly trackerUrl?: string;
  readonly siteId?: string;
  readonly customUrl?: string;
  readonly documentTitle?: string;
  readonly referrerUrl?: string;
  /** Hits pushed before the tag configured itself; the standard snippet tracks first. */
  readonly pending: readonly Params[];
  /** Unknown command names already reported — each one debugs exactly once. */
  readonly reported: readonly string[];
}

export interface Reduction {
  readonly state: ShimState;
  readonly effects: readonly Effect[];
}

export const INITIAL_STATE: ShimState = { pending: [], reported: [] };

/** Every production tag pushes 15 (docs/01); a bare `enableHeartBeatTimer` means the same. */
const DEFAULT_HEARTBEAT_SECONDS = 15;
/** Cap on hits held for an unconfigured queue — a tag that never configures is a page bug, not a leak. */
const MAX_PENDING = 20;
const NO_EFFECTS: readonly Effect[] = [];

type ConfigKey = 'trackerUrl' | 'siteId' | 'customUrl' | 'documentTitle' | 'referrerUrl';

/**
 * Apply one `_paq` entry. Anything unrecognized is ignored — a tracker must be
 * impossible to break from the tag side (CLAUDE.md invariant 4).
 */
export function reduce(state: ShimState, command: unknown, page: PageInfo): Reduction {
  const parts = Array.isArray(command) ? (command as unknown[]) : undefined;
  const name = typeof parts?.[0] === 'string' ? parts[0] : undefined;
  if (parts === undefined || name === undefined) return { state, effects: NO_EFFECTS };
  const args = parts.slice(1);

  switch (name) {
    case 'setTrackerUrl':
      return assign(state, 'trackerUrl', text(args[0]));
    case 'setSiteId':
      return assign(state, 'siteId', text(args[0]));
    case 'setCustomUrl':
      return assign(state, 'customUrl', text(args[0]));
    case 'setDocumentTitle':
      return assign(state, 'documentTitle', text(args[0]));
    case 'setReferrerUrl':
      return assign(state, 'referrerUrl', text(args[0]));
    case 'trackPageView':
      return emit(state, pageviewParams(state, page, text(args[0])));
    case 'trackEvent':
      return emit(state, eventParams(state, page, args));
    case 'trackLink':
      return emit(state, linkParams(state, page, text(args[0]), text(args[1])));
    case 'enableLinkTracking':
      return { state, effects: [{ kind: 'link-tracking' }] };
    case 'enableHeartBeatTimer':
      return { state, effects: [{ kind: 'heartbeat', seconds: heartbeatSeconds(args[0]) }] };
    case 'disableCookies':
      return { state, effects: NO_EFFECTS }; // always cookieless (docs/04 § 1)
    default:
      return unknown(state, name);
  }
}

/** A heartbeat tick. Pings carry the page and nothing else — the server clock is authoritative. */
export function ping(state: ShimState, page: PageInfo): Reduction {
  return emit(state, [
    ['ping', '1'],
    ['url', currentUrl(state, page)],
  ]);
}

function assign(state: ShimState, key: ConfigKey, value: string | undefined): Reduction {
  if (value === undefined) return { state, effects: NO_EFFECTS };
  return drain({ ...state, [key]: value });
}

/** The standard snippet calls `setTrackerUrl`/`setSiteId` *after* `trackPageView`. */
function drain(state: ShimState): Reduction {
  const { trackerUrl, siteId, pending } = state;
  if (trackerUrl === undefined || siteId === undefined || pending.length === 0) {
    return { state, effects: NO_EFFECTS };
  }
  const effects = pending.map((params) => beacon(trackerUrl, siteId, params));
  return { state: { ...state, pending: [] }, effects };
}

function emit(state: ShimState, params: Params | undefined): Reduction {
  if (params === undefined) return { state, effects: NO_EFFECTS };
  const { trackerUrl, siteId } = state;
  if (trackerUrl === undefined || siteId === undefined) {
    if (state.pending.length >= MAX_PENDING) return { state, effects: NO_EFFECTS };
    return { state: { ...state, pending: [...state.pending, params] }, effects: NO_EFFECTS };
  }
  return { state, effects: [beacon(trackerUrl, siteId, params)] };
}

/** `send_image=0` asks for a 204: the tracking GIF only exists for `<img>` tags (docs/04 § 1). */
function beacon(trackerUrl: string, siteId: string, params: Params): Effect {
  const all: Params = [['idsite', siteId], ['rec', '1'], ...params, ['send_image', '0']];
  const body = all.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return { kind: 'beacon', beacon: { url: trackerUrl, body } };
}

function pageviewParams(state: ShimState, page: PageInfo, title: string | undefined): Params {
  const params: (readonly [string, string])[] = [['url', currentUrl(state, page)]];
  const documentTitle = title ?? state.documentTitle ?? page.title;
  if (documentTitle) params.push(['action_name', documentTitle]);
  const referrer = state.referrerUrl ?? page.referrer;
  if (referrer) params.push(['urlref', referrer]);
  if (page.screen) params.push(['res', page.screen]);
  if (page.lang) params.push(['lang', page.lang]);
  return params;
}

/** Matomo events need a category and an action; a half-declared one is dropped. */
function eventParams(state: ShimState, page: PageInfo, args: unknown[]): Params | undefined {
  const category = text(args[0]);
  const action = text(args[1]);
  if (category === undefined || action === undefined) return undefined;
  const params: (readonly [string, string])[] = [
    ['url', currentUrl(state, page)],
    ['e_c', category],
    ['e_a', action],
  ];
  const name = text(args[2]);
  if (name !== undefined) params.push(['e_n', name]);
  const value = Number(args[3]);
  if (args[3] !== undefined && Number.isFinite(value)) params.push(['e_v', String(value)]);
  return params;
}

function linkParams(
  state: ShimState,
  page: PageInfo,
  target: string | undefined,
  kind: string | undefined,
): Params | undefined {
  if (target === undefined) return undefined;
  return [
    [kind === 'download' ? 'download' : 'link', target],
    ['url', currentUrl(state, page)],
  ];
}

function unknown(state: ShimState, name: string): Reduction {
  if (state.reported.includes(name)) return { state, effects: NO_EFFECTS };
  return {
    state: { ...state, reported: [...state.reported, name] },
    effects: [{ kind: 'debug', message: `ignoring unsupported _paq command: ${name}` }],
  };
}

function currentUrl(state: ShimState, page: PageInfo): string {
  return state.customUrl ?? page.url;
}

function heartbeatSeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_HEARTBEAT_SECONDS;
}

/** Tags pass site ids as either strings or numbers; empty values leave state alone. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
