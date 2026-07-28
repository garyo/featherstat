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

import type { Dashboard, QueryResponse } from '@analytics/shared';

/** `GET /share/:token` body (the server's `ShareView`): the layout and its batch, one response. */
export interface SharePayload {
  dashboard: Dashboard;
  results: QueryResponse['results'];
  meta: QueryResponse['meta'];
}

/** base64url of the server's 32 random bytes — routes/share.ts TOKEN_SHAPE, verbatim. */
const TOKEN = '[A-Za-z0-9_-]{43}';
const SHARE_PATH = new RegExp(`^/(?:s|share)/(${TOKEN})/?$`);

/** The token this URL asks for, or undefined for every other path in the app. */
export function shareTokenFromPath(pathname: string): string | undefined {
  return SHARE_PATH.exec(pathname)?.[1];
}

/** The copyable link for a freshly minted token — shown once, never recoverable. */
export function shareLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/s/${token}`;
}

/** Where the page reads its payload: the endpoint itself, always JSON. */
export function shareEndpoint(token: string): string {
  return `/share/${encodeURIComponent(token)}`;
}
