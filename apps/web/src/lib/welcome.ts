/**
 * User-invite claim links (docs/04 § 5): the admin shares `/welcome/<token>`;
 * the page there asks the invitee to choose a password and POSTs it to
 * `POST /claim/:token`, which consumes the single-use link and signs them in.
 */

/** `fsu_` + base64url of 32 random bytes — routes/users.ts LINK_TOKEN_SHAPE, verbatim. */
const WELCOME_PATH = /^\/welcome\/(fsu_[A-Za-z0-9_-]{43})\/?$/;

/** The invite token this URL carries, or undefined for every other path. */
export function welcomeTokenFromPath(pathname: string): string | undefined {
  return WELCOME_PATH.exec(pathname)?.[1];
}
