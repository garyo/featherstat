import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('scrypt password hashing', () => {
  it('round-trips: a hashed password verifies against itself', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('right');
    expect(await verifyPassword('wrong', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('right ', stored)).toBe(false);
  });

  it('stores the directive parameters (N=2^15, r=8, p=1) and a 32-byte salt', async () => {
    const stored = await hashPassword('secret-enough');
    const [scheme, n, r, p, salt, key] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect([n, r, p]).toEqual(['32768', '8', '1']);
    expect(Buffer.from(salt ?? '', 'base64url')).toHaveLength(32);
    expect(Buffer.from(key ?? '', 'base64url')).toHaveLength(64);
  });

  it('salts: hashing the same password twice never repeats', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('treats a tampered or malformed stored hash as a mismatch, never a crash', async () => {
    const stored = await hashPassword('secret-enough');
    const tampered = stored.slice(0, -2) + (stored.endsWith('aa') ? 'bb' : 'aa');
    expect(await verifyPassword('secret-enough', tampered)).toBe(false);
    for (const garbage of ['', 'scrypt', 'argon2$x$y', 'scrypt$1$1$1$$', `${stored}$extra`]) {
      expect(await verifyPassword('secret-enough', garbage), garbage).toBe(false);
    }
  });

  it('refuses stored parameters that would exceed the memory cap', async () => {
    const stored = await hashPassword('secret-enough');
    const inflated = stored.replace('$32768$', '$1048576$');
    expect(await verifyPassword('secret-enough', inflated)).toBe(false);
  });
});
