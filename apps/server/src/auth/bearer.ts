/**
 * The `Authorization: Bearer <credential>` scheme, parsed in ONE place so every
 * surface that reads the header (the session gate, the metrics endpoint) agrees
 * about what one is.
 *
 * RFC 7235 makes `auth-scheme` a case-INSENSITIVE token followed by `1*SP`, so
 * `bearer`, `BEARER` and `Bearer` are the same scheme — a client that spells it
 * lowercase is not unauthorized. The credential is returned VERBATIM: a
 * `fs_<base64url>` token is case-sensitive, and folding it would turn a
 * mistyped token into a different one rather than a rejected one.
 */
const BEARER_SCHEME = /^bearer +/i;

export function bearerCredential(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const scheme = BEARER_SCHEME.exec(header);
  return scheme === null ? undefined : header.slice(scheme[0].length);
}
