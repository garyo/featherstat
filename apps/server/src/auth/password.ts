import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Single-admin password hashing (docs/02 § Security posture) on node:crypto
 * scrypt — no dependency, memory-hard, and the parameters travel with the hash
 * so they can be raised later without invalidating stored credentials.
 */

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;
/** scrypt needs ~128·N·r bytes; node's 32 MiB default is exactly too small for N=2^15, r=8. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function derive(password: string, params: Omit<ScryptParams, 'key'>): Promise<Buffer> {
  const { N, r, p, salt } = params;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

/** `scrypt$N$r$p$salt$key` with base64url binary fields — one string for the settings table. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt });
  const fields = [SCRYPT_N, SCRYPT_R, SCRYPT_P, b64(salt), b64(key)];
  return `scrypt$${fields.join('$')}`;
}

/** Constant-time comparison of the derived key; a malformed stored hash is simply false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === undefined) return false;
  const key = await derive(password, parsed);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

function parseHash(stored: string): ScryptParams | undefined {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || key === undefined || rest.length > 0) {
    return undefined;
  }
  const params = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
  const sane =
    Number.isInteger(params.N) &&
    params.N > 1 &&
    Number.isInteger(params.r) &&
    params.r > 0 &&
    Number.isInteger(params.p) &&
    params.p > 0 &&
    params.salt.length > 0 &&
    params.key.length > 0 &&
    128 * params.N * params.r <= SCRYPT_MAXMEM;
  return sane ? params : undefined;
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}
