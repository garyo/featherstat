/**
 * Read-only share links (docs/04 § 5). `GET /share/:token` is the JSON endpoint:
 * the server assembles the stored dashboard's batch there and answers JSON to
 * every verb it accepts, so a browser navigating to that path lands on the
 * payload rather than on this app. The link an operator copies is therefore
 * `/s/<token>` — an ordinary navigation path the SPA fallback serves, from
 * which the page fetches the endpoint.
 *
 * Both forms are recognized: the day the endpoint content-negotiates (HTML for
 * a navigation, JSON for a fetch), `/share/<token>` renders the page too.
 */

import { linkTokenPattern } from '@featherstat/shared';
import type { RangePreset } from './state.ts';

const SHARE_PATH = new RegExp(`^/(?:s|share)/(${linkTokenPattern('share')})/?$`);

/** The token this URL asks for, or undefined for every other path in the app. */
export function shareTokenFromPath(pathname: string): string | undefined {
  return SHARE_PATH.exec(pathname)?.[1];
}

/** The copyable link for a freshly minted token — shown once, never recoverable. */
export function shareLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/s/${token}`;
}

/**
 * Where the page reads its payload: the endpoint itself, always JSON.
 *
 * The range rides along, because `?range=` is the endpoint's one client knob
 * (routes/share.ts) and the page never sent it — so every share link answered
 * the 30-day default however the link was written.
 */
export function shareEndpoint(token: string, range: RangePreset): string {
  return `/share/${encodeURIComponent(token)}?range=${range}`;
}
