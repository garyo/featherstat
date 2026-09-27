/**
 * Claim links (docs/04 § 5). Both are ordinary navigation paths the SPA
 * fallback serves, so opening one — or a chat app unfurling it — spends
 * nothing; the page's own POST is the claim:
 *
 * - `/welcome/<fsu_…>` — a user invite: the invitee chooses a password and the
 *   page POSTs it to `/claim/:token`.
 * - `/invite/<fsv_…>` — a viewer's magic link: one button POSTs
 *   `/invite/:token`, which signs the viewer in.
 */

export interface ClaimLink {
  kind: 'user' | 'viewer';
  token: string;
}

/** `fsu_`/`fsv_` + base64url of 32 random bytes — the server's LINK_TOKEN_SHAPEs, verbatim. */
const WELCOME_PATH = /^\/welcome\/(fsu_[A-Za-z0-9_-]{43})\/?$/;
const INVITE_PATH = /^\/invite\/(fsv_[A-Za-z0-9_-]{43})\/?$/;

/** The claim link this URL is, or undefined for every other path. */
export function claimLinkFromPath(pathname: string): ClaimLink | undefined {
  const user = WELCOME_PATH.exec(pathname)?.[1];
  if (user !== undefined) return { kind: 'user', token: user };
  const viewer = INVITE_PATH.exec(pathname)?.[1];
  return viewer === undefined ? undefined : { kind: 'viewer', token: viewer };
}
